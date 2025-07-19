const { Connection, clusterApiUrl,LAMPORTS_PER_SOL} = require('@solana/web3.js');
require('dotenv').config();
const parseTx = require('./rpc_parse.js');
const Calculator = require('./calculator.js');
const mysql = require('mysql2/promise');

// 连接到 Solana 主网官方 RPC
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
//连接数据库
const mysqlpool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'root',
  database: 'solll',
  port:'8082',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
let rows = [];
const targetWallet = process.env.WALLET;
console.log("模拟跟单的钱包地址:",targetWallet);
const buyValue = process.env.BUY_VALUE;
const buyValueRatio = process.env.BUY_VALUE_RATIO;
let buy = null;
let fixedAmount = 0;
if(buyValueRatio){
    buy = '2';
    fixedAmount = buyValueRatio;
}else if(buyValue){
    buy = '1';
    fixedAmount = null;
}
const buyPriority = process.env.BUY_PRIORITY;   //优先费
const buyGas = process.env.BUY_GAS;   //gas费
const buyPack = process.env.BUY_PACK;   //打包费
const sellinfo = process.env.SELL_VALUE;
const sellRatio = process.env.SELL_VALUE_RATIO;
let sell = null;
if(sellinfo){
  sell = '1';
}else if(sellRatio){
  sell = '2';
}
const sellPriority = process.env.SELL_PRIORITY;
const sellGas = process.env.SELL_GAS;
const sellPack = process.env.SELL_PACK;
const marketCapUpp = Number(process.env.MARKET_VALUE_UPP) || Infinity;
const marketCapLow = Number(process.env.MARKET_VALUE_LOW) || 0;
const tokenDateUpp = Number(process.env.TOKEN_UPP) || Infinity;
const tokenDateLow = Number(process.env.TOKEN_LOW) || 0;
const tokenPriceUpp = Number(process.env.PRICE_UPP) || Infinity;
const tokenPriceLow = Number(process.env.PRICE_LOW) || 0;
const stopProfit = process.env.STOP_PROFIT !== undefined && process.env.STOP_PROFIT !== ''
  ? Number(process.env.STOP_PROFIT)
  : Infinity; 
const stopLoss = process.env.STOP_LOSS !== undefined && process.env.STOP_LOSS !== ''
  ? Number(process.env.STOP_LOSS)
  : -1; 
  const txInfoList = [];
  const txInfo = {
    time: "",            // 时间
    tokenAddress: "",    // 代币地址
    tokenSymbol: "",     // 代币简称
    pool: "",            // 池子
    marketCap: 0,        // 当前市值
    tokenAge: 0,         // 代币年龄
    type: "",            // 类型
    remark: "",          // 备注
    fixedAmount: 0,      // 固定金额
    send: 0,             // 发送
    sendToken: "",       // 发送币种
    getAmount: 0,         // 获得数量
    getToken: "",         // 获得币种
    priorityFee: 0,      // 优先费
    gasFee: 0,           // gas费
    packageFee: 0,       // 打包费
    fee: 0,              // 手续费
    tipTotal: 0,         // 小费总计
    targetSend: 0,       // 目标发送
    targetSendToken: "", // 目标发送币种
    targetGetAmount: 0,   // 目标获得数量
    targetGetToken: "",   // 目标获得币种
    targetPriorityFee: 0, // 目标优先费
    targetGasFee: 0, // 目标gas费
    targetPackageFee: 0, // 目标打包费
    targetFee: 0, // 目标手续费
    targetTipTotal:0,
    followTotalPnL: 0,   // 跟随总盈亏
    followTotalPnLRatio: 0, // 跟随总盈亏比
    targetTotalPnL: 0,   // 目标总盈亏
    targetTotalPnLRatio: 0 // 目标总盈亏比
  };
//查询交易详情
async function getTransactionDetail(txHash, retry = 10) {
  for (let attempt = 1; attempt <= retry; attempt++) {
    try {
      const txDetail = await connection.getParsedTransaction(txHash, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      await new Promise((resolve) => setTimeout(resolve, 4100));
      if (txDetail) return txDetail;
      throw new Error('txDetail is null');
    } catch (err) {
      console.warn(`获取交易详情失败，重试第${attempt}次:`, err.message || err);
      if (attempt === retry) {
        console.error(`获取交易详情失败，已重试${retry}次，跳过该交易`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
function convertByMath(number) {
  // 计算小数点后的位数
  const decimalPlaces = (number.toString().split('.')[1] || '').length;
  // 乘以10的相应次方
  return Math.round(number * Math.pow(10, decimalPlaces));
}
async function main() {
  [rows] = await mysqlpool.query('SELECT * FROM wallet_token_trade');
  //console.log(rows[0]); // 确认数据
  let programId = null;
  // 使用特定代币余额管理
  let tokenBalances = {}; 
  let tokenBuyAmounts = {}; 
  let tokenSellAmounts = {}; 
  
  // 目标钱包独立代币余额管理
  let targetTokenBalances = {};
  let targetTokenBuyAmounts = {}; 
  let targetTokenSellAmounts = {}; 
  
  let targetBalance = 0;
  let targetBuyValue = 0;
  let targetSellValue = 0;
  let targetSellPriority = 0;
  let sellValue = 0;
  let targetSellAmount = 0;
  const tokenDate = 1;
  let result = {};
  let targetSellPnl = 0;
  let targetSellPnlRatio = 0;
  let totalBuyAmount = 0;   // 累计所有买入金额（sol）
  let totalSellValue = 0;  // 累计所有卖出金额（sol）
  let pool = null;
  let targetFee = 0;
  let feeInfo = 0;
  let targetpriorityFee = '';
  let calculat = new Calculator();
  let parse = new parseTx();
  let sucess = null;
  let fee = 0;

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].wallet_address !== targetWallet) continue;
    const tokenPrice = Number(rows[i].price_usd);
    const tokenMarketCap = tokenPrice * 1e9;
    const baseAmount = Number(rows[i].base_amount);
    const tokenAddress = rows[i].token_address;
    
    // 初始化代币余额（如果不存在）
    if (!tokenBalances[tokenAddress]) {
      tokenBalances[tokenAddress] = 0;
    }
    
    // 策略过滤
    if (
      tokenMarketCap > Number(marketCapLow) && tokenMarketCap < Number(marketCapUpp) &&
      tokenPrice > Number(tokenPriceLow) && tokenPrice < Number(tokenPriceUpp) &&
      tokenDate > Number(tokenDateLow) && tokenDate < Number(tokenDateUpp)
    ) {
      if (rows[i].event === 'buy') {
        console.log('购买的交易hash',rows[i].tx_hash);
        const txDetail = await getTransactionDetail(rows[i].tx_hash);
        if (!txDetail) {
          console.log('跳过无法获取的交易详情');
          continue;
        }
        //console.log('购买的交易详细',txDetail);
        result = parse.handleParseTx(txDetail);
        if (!result.tradeList || !result.tradeList[0]) continue;
        programId = result.tradeList[0].programId;
        targetBuyValue = (txDetail.meta.preBalances[0] - txDetail.meta.postBalances[0]) / 1e9;
        console.log("目标买入",targetBuyValue);
        if (!programId) {
          continue;
        }
        if(programId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'){
          pool = 'pumpFun';
        }else if(programId === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'){
          pool = 'pumpFunAMM';
        }else if(programId === 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj'){
          pool = 'launchpad';
        }else if(programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'){
          pool = 'raydiumAmm v4'
        }else if(programId === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'){
          pool = 'raydiumCPMM'
        }else{
          continue;
        }
        txInfo.time = rows[i].trade_time;
        txInfo.marketCap = tokenMarketCap;
        if(pool === 'pumpFun'){
          feeInfo = result.tradeList[0].logData.inputTransferFee;
          fee = 0.001;
          targetpriorityFee = Number(result.priority_fee);
          targetFee = Number(feeInfo)/1e9;
        }else if(pool === 'pumpFunAMM'){
          fee = 0.0003;
          feeInfo = result.tradeList[0].logData.protocolFee;
          targetpriorityFee = Number(result.priority_fee);
          targetFee = Number(feeInfo)/1e9;
        }else if(pool === 'launchpad'){
          fee = 0.0035;
          feeInfo = Number(result.tradeList[0].logData.protocolFee) + Number(result.tradeList[0].logData.platformFee);
          targetpriorityFee = Number(result.priority_fee);
          targetFee = Number(feeInfo)/1e9
        }else if(pool === 'raydiumAmm v4'){
          fee = 0.0025;
          targetFee = Number(targetBuyValue) * 0.0025;
          targetpriorityFee = Number(result.priority_fee);
        }else if(pool === 'raydiumCPMM'){
          if(result.tradeList[0].tradeKeys[2] === 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2'){
            fee = 0.0025;
          }else if(result.tradeList[0].tradeKeys[2] === 'BgxH5ifebqHDuiADWKhLjXGP5hWZeZLoCdmeWJLkRqLP'){
            fee = 0.003;
          }else if(result.tradeList[0].tradeKeys[2] === 'BhH6HphjBKXu2PkUc2aw3xEMdUvK14NXxE5LbNWZNZAA'){
            fee = 0.005;
          }else if(result.tradeList[0].tradeKeys[2] === 'B5u5x9S5pyaJdonf7bXUiEnBfEXsJWhNxXfLGAbRFtg2'){
            fee = 0.015;
          }else if(result.tradeList[0].tradeKeys[2] === 'C7Cx2pMLtjybS3mDKSfsBj4zQ3PRZGkKt7RCYTTbCSx2'){
            fee =0.04;
          }
          targetFee = Number(result.tradeList[0].logData.inputTransferFee)/1e9;
          targetpriorityFee = Number(result.priority_fee)/ 1e9;
        }
        
        // 更新目标钱包的代币余额和买入金额
        if (!targetTokenBalances[tokenAddress]) {
          targetTokenBalances[tokenAddress] = 0;
        }
        if (!targetTokenBuyAmounts[tokenAddress]) {
          targetTokenBuyAmounts[tokenAddress] = 0;
        }
        targetTokenBalances[tokenAddress] += Number(rows[i].base_amount);
        targetTokenBuyAmounts[tokenAddress] += targetBuyValue;
        console.log(`总目标买入${tokenAddress}`,targetTokenBuyAmounts[tokenAddress]);
        
        if (buy === '1') {
          // 定额买
          sucess = '成功';
          console.log(`跟随买入: ${sucess}\n数量：${buyValue}`);
          //const a = result.tradeList[0];
          console.log("参数2",Number(buyValue));
          const buyToken =calculat.getAmountBySol(result.tradeList[0],Number(buyValue) * LAMPORTS_PER_SOL);
          console.log("买入数量:",Number(buyToken)/1e6);
          // 更新对应代币的余额和买入金额
          tokenBalances[tokenAddress] += Number(buyToken)/1e6;
          if (!tokenBuyAmounts[tokenAddress]) {
            tokenBuyAmounts[tokenAddress] = 0;
          }
          tokenBuyAmounts[tokenAddress] += Number(buyValue);
          totalBuyAmount += Number(buyValue);
          console.log(`代币 ${tokenAddress} 累计买入金额: ${tokenBuyAmounts[tokenAddress]}`);
          console.log(`当前累计买入金额: ${totalBuyAmount}`);
          const buyTip = buyPriority + buyGas + buyPack;
          const buyinfo = {
            time: rows[i].trade_time,
            tokenAddress: rows[i].token_address,
            tokenSymbol: "",    //从数据库拿
            pool: pool,    
            marketCap: tokenMarketCap,
            tokenAge: 0,    //从数据库拿
            type: "buy",   
            remark: "",
            fixedAmount: fixedAmount,
            send: buyValue,
            sendToken: "SOL",
            getAmount: buyToken,
            getToken: "", //从数据库拿
            priorityFee: buyPriority,
            gasFee: buyGas,
            packageFee: buyPack,
            fee: Number(buyValue)*fee,
            tipTotal: buyTip,
            targetSend:(txDetail.meta.preBalances[0] - txDetail.meta.postBalances[0]) / 1e9,
            targetSendToken: "SOL",
            targetGetAmount: rows[i].base_amount,
            targetGetToken: "",  //和上面那个一样
            targetPriorityFee: targetpriorityFee,   
            targetGasFee: Number(result.gas)/1e9,   
            targetPackageFee: Number(result.tip)/1e9,
            targetFee: targetFee,
            targetTipTotal: (targetpriorityFee || 0) + (Number(result.gas)/1e9 || 0) + (Number(result.tip)/1e9 || 0) + (Number(targetFee)/1e9 || 0),
          }
          console.log('购买信息',buyinfo);
          console.log(`代币 ${tokenAddress} 当前余额: ${tokenBalances[tokenAddress]}`);
          txInfoList.push(buyinfo);
        } else if (buy === '2') {
          // 按比例买入
          const buyToken = calculat.getAmountBySol(result.tradeList[0],Number(targetBuyValue)*Number(buyValueRatio)*LAMPORTS_PER_SOL);
          //console.log("跟随买入：",buyToken);
          // 更新对应代币的余额和买入金额
          tokenBalances[tokenAddress] += Number(buyToken)/1e6;
          if (!tokenBuyAmounts[tokenAddress]) {
            tokenBuyAmounts[tokenAddress] = 0;
          }
          const buyAmount = Number(buyValueRatio) * targetBuyValue;
          tokenBuyAmounts[tokenAddress] += buyAmount;
          totalBuyAmount += buyAmount;
          sucess = '成功';
          console.log(`跟随买入: ${sucess}\n数量：${buyToken}`);
          console.log(`代币 ${tokenAddress} 累计买入金额: ${tokenBuyAmounts[tokenAddress]}`);
          console.log(`当前累计买入金额: ${totalBuyAmount}`);
          const buyTip = buyPriority+buyGas+buyPack
          const buyinfo = {
            time: rows[i].trade_time,
            tokenAddress: rows[i].token_address,
            tokenSymbol: "",    //从数据库拿
            pool: pool,    //从数据库拿
            marketCap: tokenMarketCap,
            tokenAge: 0,    //从数据库拿
            type: "buy",   
            remark: "",
            fixedAmount: Number(buyValueRatio),
            send: Number(buyValueRatio) * targetBuyValue,
            sendToken: "",
            getAmount: buyToken,
            getToken: "SOL", //从数据库拿
            priorityFee: buyPriority,
            gasFee: buyGas,
            packageFee: buyPack,
            fee:  Number(buyValueRatio) * targetBuyValue * fee,
            tipTotal: buyTip,
            targetSend: (txDetail.meta.preBalances[0] - txDetail.meta.postBalances[0]) / 1e9,
            targetSendToken: "",
            targetGetAmount: rows[i].base_amount,
            targetGetToken: "SOL",  
            targetPriorityFee: Number(result.priorityFee)/1e9,   
            targetPackageFee: Number(result.tip)/1e9,   
            targetFee: targetFee,  
            targetTipTotal: (targetpriorityFee || 0) + (Number(result.gas)/1e9 || 0) + (Number(result.tip)/1e9 || 0) + (Number(targetFee)/1e9 || 0),
          }
          console.log('购买信息',buyinfo);
          console.log(`代币 ${tokenAddress} 当前余额: ${tokenBalances[tokenAddress]}`);
          txInfoList.push(buyinfo);
        }
        
        targetBalance += baseAmount;
      };

      // 检查当前代币是否有余额
      if(tokenBalances[tokenAddress] > 0 ){
        // 止盈/止损分支前加安全判断
        if (!result.tradeList || !result.tradeList[0]) continue;
        console.log("")
        sellValue = Number(calculat.getSolByAmount(result.tradeList[0],convertByMath(Number(tokenBalances[tokenAddress]))))/1e9;
        if (sellValue > tokenBuyAmounts[tokenAddress] * (1 + Number(stopProfit))) {
          // 止盈
          const txDetail = await getTransactionDetail(rows[i].tx_hash);
          result = parse.handleParseTx(txDetail);
          if (!result.tradeList || !result.tradeList[0]) continue;
          totalSellValue += Number(sellValue);
          if (!tokenSellAmounts[tokenAddress]) {
            tokenSellAmounts[tokenAddress] = 0;
          }
          tokenSellAmounts[tokenAddress] += Number(sellValue);
          sucess = '成功';
          console.log(`止盈: ${sucess}\n比例：${stopProfit}`);
          const sellTip = sellPriority + sellGas + sellPack;
          const sellPnL = Number(sellValue) - tokenBuyAmounts[tokenAddress];
          const pnlRatio = sellPnL / tokenBuyAmounts[tokenAddress];
          const sellinfo = {
            time: rows[i].trade_time,
            tokenAddress: rows[i].token_address,
            tokenSymbol: "",    //从数据库拿
            pool: pool,    //从数据库拿
            marketCap: tokenMarketCap,
            tokenAge: 0,    //从数据库拿
            type: "sell",   
            remark: `止盈${stopProfit}卖出`,
            fixedAmount: '100%',
            send: tokenBalances[tokenAddress],
            sendToken: "",
            getAmount: sellValue,
            getToken: "SOL", //从数据库拿
            priorityFee: sellPriority,
            gasFee: sellGas,
            packageFee: sellPack,
            fee: Number(sellValue) * fee,
            tipTotal: sellTip,
            targetSend: 0,
            targetSendToken: "",
            targetGetAmount: 0,
            targetGetToken: "",  
            targetPriorityFee: 0,   
            targetGasFee: 0,  
            targetPackageFee: 0,  
            targetFee: 0,  
            targetTipTotal: 0,
            followTotalPnL: sellPnL.toFixed(2),   // 跟随总盈亏
            followTotalPnLRatio: Math.abs(pnlRatio) < 1e-8 ? '0%' : (pnlRatio * 100).toFixed(2) + '%', // 跟随总盈亏比
          }
          console.log('止盈信息',sellinfo);
          txInfoList.push(sellinfo);
          
          // 清空对应代币的余额
          tokenBalances[tokenAddress] = 0;
          continue;
        } else if (Number(sellValue) < tokenBuyAmounts[tokenAddress] * (1 - Number(stopLoss))) {
          // 止损
          const txDetail = await getTransactionDetail(rows[i].tx_hash);
          result = parse.handleParseTx(txDetail);
          if (!result.tradeList || !result.tradeList[0]) continue;
          totalSellValue += Number(sellValue);
          if (!tokenSellAmounts[tokenAddress]) {
            tokenSellAmounts[tokenAddress] = 0;
          }
          tokenSellAmounts[tokenAddress] += Number(sellValue);
          console.log('stopLoss:', stopLoss, 'Number(stopLoss):', Number(stopLoss));
          sucess = '成功';
          console.log(`止损: ${sucess}\n比例：${stopLoss}`);
          const sellTip = sellPriority + sellGas + sellPack;
          const sellPnL = Number(sellValue) - tokenBuyAmounts[tokenAddress];
          const pnlRatio = sellPnL / tokenBuyAmounts[tokenAddress];
          const sellinfo = {
            time: rows[i].trade_time,
            tokenAddress: rows[i].token_address,
            tokenSymbol: "",    //从数据库拿
            pool: pool,    //从数据库拿
            marketCap: tokenMarketCap,
            tokenAge: 0,    //从数据库拿
            type: "sell",   
            remark: `止损${stopLoss}卖出`,
            fixedAmount: '100%',
            send: tokenBalances[tokenAddress],
            sendToken: "",
            getAmount: Number(sellValue),
            getToken: "SOL", //从数据库拿
            priorityFee: sellPriority,
            gasFee: sellGas,
            packageFee: sellPack,
            fee: Number(sellValue) * fee,
            tipTotal: sellTip,
            targetSend: 0,
            targetSendToken: "",
            targetGetAmount: 0,
            targetGetToken: "",  
            targetPriorityFee: 0,   
            targetGasFee: 0,  
            targetPackageFee: 0,  
            targetFee: 0,  
            targetTipTotal: 0,
            followTotalPnL: sellPnL.toFixed(2),   // 跟随总盈亏
            followTotalPnLRatio: Math.abs(pnlRatio) < 1e-8 ? '0%' : (pnlRatio * 100).toFixed(2) + '%', // 跟随总盈亏比
          }
          console.log('止损信息',sellinfo);
          txInfoList.push(sellinfo);
          // 清空对应代币的余额
          tokenBalances[tokenAddress] = 0;
          continue;
        }
      }
      if (rows[i].event === 'sell') {
        const txDetail = await getTransactionDetail(rows[i].tx_hash);
        //console.log("txDetail:",txDetail);
        result = parse.handleParseTx(txDetail);
        console.log('卖出交易hash',rows[i].tx_hash);
        if (!result.tradeList || !result.tradeList[0]) continue;
        if(!programId){
          continue;
        }
        if(programId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'){
          pool = 'pumpFun';
        }else if(programId === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'){
          pool = 'pumpFunAMM';
        }else if(programId === 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj'){
          pool = 'launchpad';
        }else if(programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'){
          pool = 'raydiumAmm v4'
        }else if(programId === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'){
          pool = 'raydiumCPMM'
        }else{
          continue;
        }
        targetTokenBalances[tokenAddress] -= Number(rows[i].base_amount);
        targetSellValue = Number((txDetail.meta.postBalances[0] - txDetail.meta.preBalances[0])) / 1e9;
        console.log("目标卖出",targetSellValue);
        if (typeof targetTokenSellAmounts[tokenAddress] !== 'number') {
          targetTokenSellAmounts[tokenAddress] = 0;
        }
        targetTokenSellAmounts[tokenAddress] += targetSellValue;
        console.log(`总目标卖出${tokenAddress}`,targetTokenSellAmounts[tokenAddress]);
        if (targetTokenBalances[tokenAddress] < 0) targetTokenBalances[tokenAddress] = 0;

        // 如果目标钱包余额归零，插入目标盈亏
        if (targetTokenBalances[tokenAddress] === 0) {
          // 计算目标盈亏
          const targetSellPnL = (targetTokenSellAmounts[tokenAddress] || 0) - (targetTokenBuyAmounts[tokenAddress] || 0);
          const targetPnlRatio = (targetTokenBuyAmounts[tokenAddress] || 0) > 0 ? targetSellPnL / targetTokenBuyAmounts[tokenAddress] : 0;
          for (let j = txInfoList.length - 1; j >= 0; j--) {
            if (txInfoList[j].tokenAddress === tokenAddress && txInfoList[j].followTotalPnL) {
              txInfoList[j].targetTotalPnL = Number(targetSellPnL).toFixed(2);
              console.log("目标收益:",targetSellPnL);
              txInfoList[j].targetTotalPnLRatio = Math.abs(Number(targetPnlRatio)) < 1e-8 ? '0%' : (Number(targetPnlRatio) * 100).toFixed(2) + '%';
              console.log("目标盈亏比:",targetPnlRatio);
              console.log(`【目标钱包归零】已更新代币 ${tokenAddress} 的目标盈亏信息`);
              break;
            }
          }
        }
        // 检查代币余额，如果为0则跳过卖出交易
        if (!tokenBalances[tokenAddress] || tokenBalances[tokenAddress] <= 0) {
          console.log(`代币 ${tokenAddress} 余额为0，跳过卖出交易`);
          continue;
        }
        //programId = result.tradeList[0].programId;
        //console.log("program:",programId);
        targetSellAmount = Number(rows[i].base_amount);
        //console.log("pool",pool);
        txInfo.time = rows[i].trade_time;
        txInfo.marketCap = tokenMarketCap;
        if(pool === 'pumpFun'){
          fee = 0.001;
          feeInfo = result.tradeList[0].logData.inputTransferFee;
          targetpriorityFee = Number(result.priority_fee);
          targetFee = Number(feeInfo)/1e9;
        }else if(pool === 'pumpFunAMM'){
          fee = 0.0003;
          feeInfo = result.tradeList[0].logData.protocolFee;
          targetpriorityFee = Number(result.priority_fee);
          targetFee = Number(feeInfo)/1e9;
        }else if(pool === 'launchpad'){
          fee = 0.0035;
          feeInfo = Number(result.tradeList[0].logData.protocolFee) + Number(result.tradeList[0].logData.platformFee);
          targetpriorityFee = Number(result.priority_fee);
          targetFee = Number(feeInfo)/1e9
        }else if(pool === 'raydiumAmm v4'){
          fee = 0.0025;
          targetFee = Number(targetBuyValue) * 0.0025;
          targetpriorityFee = Number(result.priority_fee);
        }else if(pool === 'raydiumCPMM'){
          if(result.tradeList[0].tradeKeys[2] === 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2'){
            fee = 0.0025;
          }else if(result.tradeList[0].tradeKeys[2] === 'BgxH5ifebqHDuiADWKhLjXGP5hWZeZLoCdmeWJLkRqLP'){
            fee = 0.003;
          }else if(result.tradeList[0].tradeKeys[2] === 'BhH6HphjBKXu2PkUc2aw3xEMdUvK14NXxE5LbNWZNZAA'){
            fee = 0.005;
          }else if(result.tradeList[0].tradeKeys[2] === 'B5u5x9S5pyaJdonf7bXUiEnBfEXsJWhNxXfLGAbRFtg2'){
            fee = 0.015;
          }else if(result.tradeList[0].tradeKeys[2] === 'C7Cx2pMLtjybS3mDKSfsBj4zQ3PRZGkKt7RCYTTbCSx2'){
            fee =0.04;
          }
          targetFee = Number(result.tradeList[0].logData.inputTransferFee)/1e9;
          targetpriorityFee = Number(result.priority_fee)/ 1e9;
        }
        if (sell === '1') {
          // 定额卖出
          if (!result.tradeList || !result.tradeList[0]) continue;
          sellValue = Number(calculat.getSolByAmount(result.tradeList[0],convertByMath(Number(tokenBalances[tokenAddress]))))/1e9;
          sucess = '成功';
          console.log(`定额卖出: ${sucess}\n数量：${tokenBalances[tokenAddress]}\n价值：${sellValue}`);
          totalSellValue += Number(sellValue);
          if (!tokenSellAmounts[tokenAddress]) {
            tokenSellAmounts[tokenAddress] = 0;
          }
          tokenSellAmounts[tokenAddress] += Number(sellValue);
          targetSellPnl = targetSellValue - targetTokenBuyAmounts[tokenAddress];
          targetSellPnlRatio = targetSellPnl / targetTokenBuyAmounts[tokenAddress];
          const sellTip = Number(sellPriority) + Number(sellGas) + Number(sellPack);
          const sellPnL = Number(sellValue) - tokenBuyAmounts[tokenAddress];
          const pnlRatio = sellPnL / tokenBuyAmounts[tokenAddress];
          const sellinfo = {
            time: rows[i].trade_time,
            tokenAddress: rows[i].token_address,
            tokenSymbol: "",    //从数据库拿
            pool: pool,    //从数据库拿
            marketCap: tokenMarketCap,
            tokenAge: 0,    //从数据库拿
            type: "sell",   
            remark: "",
            fixedAmount:'',
            send: tokenBalances[tokenAddress],
            sendToken: "",  //从数据库拿
            getAmount: sellValue,
            getToken: "SOL", //从数据库拿
            priorityFee: sellPriority,
            gasFee: sellGas,
            packageFee: sellPack,
            fee: Number(sellValue) * fee,
            tipTotal: sellTip,
            targetSend: Number(rows[i].base_amount), 
            targetSendToken: "",  //和上面那个一样
            targetGetAmount: targetSellValue,
            targetGetToken: "SOL",  
            targetPriorityFee: targetpriorityFee,   //从解析的数据拿  
            targetGasFee: Number(result.gas)/1e9,   //从解析的数据拿
            targetPackageFee: Number(result.tip)/1e9, 
            targetFee: targetFee,  //从解析的数据拿
            targetTipTotal: (targetpriorityFee || 0) + (Number(result.gas)/1e9 || 0) + (Number(result.tip)/1e9 || 0) + (Number(targetFee)/1e9 || 0),
            followTotalPnL: sellPnL.toFixed(2),   // 跟随总盈亏
            followTotalPnLRatio: Math.abs(pnlRatio) < 1e-8 ? '0%' : (pnlRatio * 100).toFixed(2) + '%', // 跟随总盈亏比
            targetTotalPnL: targetSellPnl.toFixed(2),
            targetTotalPnLRatio: Math.abs(targetSellPnlRatio) < 1e-8 ? '0%' : (targetSellPnlRatio * 100).toFixed(2) + '%',
          }
          console.log('定额卖出信息',sellinfo);
          txInfoList.push(sellinfo);
          // 清空对应代币的余额
          tokenBalances[tokenAddress] = 0;
        } else if (sell === '2') {
          // 按比列卖
          if (!result.tradeList || !result.tradeList[0]) continue;
          targetSellValue = Number(result.tradeList[0].logData.outputAmount)/LAMPORTS_PER_SOL;
          targetSellPnl = targetSellValue - targetTokenBuyAmounts[tokenAddress];
          targetSellPnlRatio = targetSellPnl / targetTokenBuyAmounts[tokenAddress];
          targetSellPriority = (targetSellAmount / targetBalance).toFixed(2);
          //console.log("targetSellPriority:",targetSellPriority);
          targetBalance -= targetSellAmount;
          const sellAmount = (targetSellPriority * tokenBalances[tokenAddress]).toFixed(6);
          console.log("余额：",tokenBalances[tokenAddress]);
          console.log("跟随卖出的比例",targetSellPriority);
          console.log("卖出的数量",sellAmount);
          sellValue = Number(calculat.getSolByAmount(result.tradeList[0],convertByMath(sellAmount)))/1e9;
          sucess = '成功';
          console.log(`按比例卖出: ${sucess}\n数量：${sellAmount}\n价值：${sellValue}`);
          totalSellValue += Number(sellValue); //到时候跟池子
          if (!tokenSellAmounts[tokenAddress]) {
            tokenSellAmounts[tokenAddress] = 0;
          }
          tokenSellAmounts[tokenAddress] += Number(sellValue);
          // 更新对应代币的余额
          tokenBalances[tokenAddress] -= sellAmount;
          const sellTip = sellPriority + sellGas + sellPack;
          const sellinfo = {
            time:rows[i].trade_time,
            tokenAddress: rows[i].token_address,
            tokenSymbol: "",    //从数据库拿
            pool: pool,    //从数据库拿
            marketCap: tokenMarketCap,
            tokenAge: 0,    //从数据库拿
            type: "sell",   
            remark: "",
            fixedAmount:targetSellPriority ,
            send: sellAmount,
            sendToken: "",  //从数据库拿
            getAmount: sellValue,
            getToken: "SOL", //从数据库拿
            priorityFee: sellPriority,
            gasFee: sellGas,
            packageFee: sellPack,
            fee: Number(sellValue) * fee,
            tipTotal: sellTip,
            targetSend: targetSellAmount, 
            targetSendToken: "",  //和上面那个一样
            targetGetAmount: targetSellValue,
            targetGetToken: "SOL",  
            targetPriorityFee: targetpriorityFee,   //从解析的数据拿  
            targetGasFee: Number(result.gas)/1e9,   //从解析的数据拿
            targetPackageFee: Number(result.tip)/1e9,   //从解析的数据拿
            targetFee: targetFee,   //从解析的数据拿
            targetTipTotal: (targetpriorityFee || 0) + (Number(result.gas)/1e9 || 0) + (Number(result.tip)/1e9 || 0) + (Number(targetFee)/1e9 || 0),
          }
          console.log('按比例卖出信息',sellinfo);
          txInfoList.push(sellinfo);
          if(tokenBalances[tokenAddress] === 0){
            const sellTip = sellPriority + sellGas + sellPack;
            const sellPnL = Number(tokenSellAmounts[tokenAddress]) - Number(tokenBuyAmounts[tokenAddress]);
            const pnlRatio = sellPnL / Number(tokenBuyAmounts[tokenAddress]);
  
            const targetPnlRatio = targetSellPnL / Number(targetTokenBuyAmounts[tokenAddress]);
            
            if (txInfoList.length > 0 && txInfoList[txInfoList.length - 1].type === "sell") {
              txInfoList.pop();
            }
            const finalSellinfo = {
              time: rows[i].trade_time,
              tokenAddress: rows[i].token_address,
              tokenSymbol: "",    //从数据库拿
              pool: pool,    //从数据库拿
              marketCap: tokenMarketCap,
              tokenAge: 0,    //从数据库拿
              type: "sell",   
              remark: "",
              fixedAmount:targetSellPriority ,
              send: sellAmount,
              sendToken: "",  //从数据库拿
              getAmount: Number(totalSellValue),
              getToken: "SOL", //从数据库拿
              priorityFee: sellPriority,
              gasFee: sellGas,
              packageFee: sellPack,
              fee: Number(sellValue) * fee,
              tipTotal: sellTip,
              targetSend: targetSellAmount, 
              targetSendToken: "",  //和上面那个一样
              targetGetAmount: targetSellValue,
              targetGetToken: "SOL",  
              targetPriorityFee: targetpriorityFee,     
              targetGasFee: Number(result.gas)/1e9,   
              targetPackageFee: Number(result.tip)/1e9,   
              targetFee: targetFee,   
              targetTipTotal: (targetpriorityFee || 0) + (Number(result.gas)/1e9 || 0) + (Number(result.tip)/1e9 || 0) + (Number(targetFee)/1e9 || 0),
              followTotalPnL: sellPnL.toFixed(2),   // 跟随总盈亏
              followTotalPnLRatio: Math.abs(pnlRatio) < 1e-8 ? '0%' : (pnlRatio * 100).toFixed(2) + '%', // 跟随总盈亏比
              targetTotalPnL: targetSellPnL.toFixed(2),
              targetTotalPnLRatio: Math.abs(targetPnlRatio) < 1e-8 ? '0%' : (targetPnlRatio * 100).toFixed(2) + '%',
            }
            console.log('最终卖出信息',finalSellinfo);
            txInfoList.push(finalSellinfo);
            break;
          }
        }
      }
    }
  }
  console.log("累计买入金额:", totalBuyAmount);
  console.log("累计卖出金额:", totalSellValue);
  const profit = totalSellValue - totalBuyAmount;
  console.log("总利润:", profit.toFixed(2));
  if (Number(totalBuyAmount) > 0) {
    const pnlRatio = (Number(totalSellValue) - Number(totalBuyAmount)) / Number(totalBuyAmount);
    console.log("盈亏比:", Math.abs(pnlRatio) < 1e-8 ? 0 : pnlRatio.toFixed(4));
  } else {
    console.log("盈亏比: 无买入记录");
  }
  const tableName =targetWallet || 'null wallet';
  const fields = Object.keys(txInfo)
        .map(key => `\`${key}\` VARCHAR(512)`)
        .join(', ');
        //创建表
  const createTableSQL = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ${fields}
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  await mysqlpool.execute(createTableSQL);
    // 插入数据
  for (const row of txInfoList) {
    const keys = Object.keys(row);
    const values = keys.map(k => {
      // 处理可能过长的数据
      const value = row[k];
      if (typeof value === 'string' && value.length > 1000) {
        return value.substring(0, 1000);
      }
      return value;
    });
    const placeholders = keys.map(() => '?').join(', ');
    const insertSQL = `INSERT INTO \`${tableName}\` (${keys.map(k => `\`${k}\``).join(', ')}) VALUES (${placeholders})`;
    await mysqlpool.execute(insertSQL, values);
  }
  console.log(`已存入数据库表：${tableName}`);

  const XLSX = require('xlsx');
  const fs = require('fs');

  // 字段中英文映射表
  const fieldMap = {
    time: "时间",
    tokenAddress: "代币地址",
    tokenSymbol: "代币简称",
    pool: "池子",
    marketCap: "当前市值",
    tokenAge: "代币年龄",
    type: "类型",
    remark: "备注",
    fixedAmount: "固定金额",
    send: "发送",
    sendToken: "发送币种",
    getAmount: "获得数量",
    getToken: "获得币种",
    priorityFee: "优先费",
    gasFee: "gas费",
    packageFee: "打包费",
    fee: "手续费",
    tipTotal: "小费总计",
    targetSend: "目标发送",
    targetSendToken: "目标发送币种",
    targetGetAmount: "目标获得数量",
    targetGetToken: "目标获得币种",
    targetPriorityFee: "目标优先费",
    targetGasFee: "目标gas费",
    targetPackageFee: "目标打包费",
    targetFee: "目标手续费",
    followTotalPnL: "跟随总盈亏",
    followTotalPnLRatio: "跟随总盈亏比",
    targetTotalPnL: "目标总盈亏",
    targetTotalPnLRatio: "目标总盈亏比"
  };

  // 英文转中文
  function mapFieldsToChinese(list, fieldMap) {
    return list.map(item => {
      const newItem = {};
      for (const key in item) {
        if (fieldMap[key]) {
          newItem[fieldMap[key]] = item[key];
        } else {
          newItem[key] = item[key];
        }
      }
      return newItem;
    });
  }
  // 1. 转换
  const txInfoListZh = mapFieldsToChinese(txInfoList, fieldMap);

  // 2. 新建 worksheet
  const ws = XLSX.utils.json_to_sheet(txInfoListZh);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "交易明细");
  XLSX.writeFile(wb, "txInfoList.xlsx");
  console.log("已导出 txInfoList.xlsx");
}

main();









