const { Connection, clusterApiUrl, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const parseTx = require('./rpc_parse.js');
const calculator = require('./calculator.js')
require('dotenv').config();
function convertByMath(number) {
  // 计算小数点后的位数
  const decimalPlaces = (number.toString().split('.')[1] || '').length;
  // 乘以10的相应次方
  return Math.round(number * Math.pow(10, decimalPlaces));
}

// 连接到 Solana 主网官方 RPC
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

async function getTransactionDetail(txHash) {
    const txDetail = await connection.getParsedTransaction(txHash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    return txDetail;
  }
const hash = '5mAzqawsUb6CCWaBbwaKNgEhpAo55vRLjHTr9ogj3EsiSvZYtcc7zoeF97yoGHPKWpQuuNmddT3GaN7bReSL9Gox';
const hash1 = '3LttsVtLr8pwjiRMMuadiR9DPriWWNmhRV5syGPvBFWkTnGGHAsGnt8adKvCTapSBhg8QZuiHpunhxduRrNzFgVQ';
(async () => {
  const result = await getTransactionDetail(hash);
  const result1 = await getTransactionDetail(hash1);
  //console.log("获取的交易数据",result1);
  let parse = new parseTx();
  let res = parse.handleParseTx(result);
  let res1 = parse.handleParseTx(result1);
  console.log("res1",res1);
  //console.log("tradeKeys",res1.tradeList[0].logData);
  const b = res1.tradeList[0].logData.outputAmount;
  console.log("type", typeof res1.tradeList[0].logData)
  console.log("outputAmount:",b);
  const out = Number(b)/LAMPORTS_PER_SOL;
  console.log("out:",out);
  let fee = 0;
  let targetpriorityFee = 0;
  fee = Number(res.tradeList[0].logData.inputTransferFee)/1e9;
  targetpriorityFee = Number(result.priority_fee)/ 1e9;
  //console.log("res.tip",Number(res.tip)/1e9);
  //console.log("res.gas",Number(res.gas)/1e9);
  //console.log("res.priority",Number(res.priority_fee)/1e9);
  const tiptotal = 
    (Number(result.priorityFee)/1e9 || 0) +
    (Number(result.gas)/1e9 || 0) +
    (Number(result.tip)/1e9 || 0) +
    (Number(fee)/1e9 || 0);
  //console.log(tiptotal);
  //console.log((Number(result.meta.postBalances[0]) - Number(result.meta.preBalances[0])) / 1e9);
  let calcula = new calculator();
  let data = res1.tradeList[0];
  console.log(data.logData);
  const buyValue = process.env.BUY_VALUE;
  //console.log(Number(data.logData.outputAmount)/LAMPORTS_PER_SOL)
  const a = Number(buyValue);
  console.log('11',a);
  //let buyAmount = await calcula.getAmountBySol(res.tradeList[0],a*LAMPORTS_PER_SOL);
  let buyAmount = 4426178.858889;
  let sellAmount = await calcula.getSolByAmount(res1.tradeList[0],convertByMath(Number(buyAmount)));
  //console.log("购买的数量",Number(buyAmount)/1e9);
  console.log("卖出的数量", Number(sellAmount) / 1e9);
})();
//5mAzqawsUb6CCWaBbwaKNgEhpAo55vRLjHTr9ogj3EsiSvZYtcc7zoeF97yoGHPKWpQuuNmddT3GaN7bReSL9Gox
//255168.731836
//3wBMygdpwBep4PwVht8DRcVNA5iiHYVxH8fsiRvgH6fvvj5egEipoX8mkKaViWT16M47xX7vuq5dk9EhAxUzWhUH
//107