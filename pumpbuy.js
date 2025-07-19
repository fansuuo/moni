const {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    LAMPORTS_PER_SOL,
    SystemProgram,
    ComputeBudgetProgram
} = require("@solana/web3.js");
const {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction
} = require("@solana/spl-token");
const bs58 = require('bs58');
const BN = require("bn.js");

// ================================ 配置参数 ================================
const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RPC_URL = "https://mainnet.helius-rpc.com/?api-key=你的APIKEY";      //连接solana主网

// 用户配置 - 主钱包和副钱包私钥
const MAIN_WALLET_PRIVATE_KEY = ""; // 主钱包私钥 (base58)
const SUB_WALLET_PRIVATE_KEYS = [
    "", // 副钱包1私钥
    "", // 副钱包2私钥
    "", // 副钱包3私钥
];

const MINT_ADDRESS = ""; // 你的代币mint

const DEFAULT_SLIPPAGE = 3; // 滑点 3%
const DEFAULT_PRIORITY_FEE = 0.000005; // 优先费用

// ================================ 初始化 ================================
const connection = new Connection(RPC_URL, 'confirmed');
const mainWallet = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_PRIVATE_KEY));
const subWallets = SUB_WALLET_PRIVATE_KEYS.map(key => Keypair.fromSecretKey(bs58.decode(key)));

// ================================ 工具函数 ================================

class BondingCurveAccount {
    constructor(data) {
        let offset = 8; // 跳过 discriminator

        this.virtualTokenReserves = new BN(data.subarray(offset, offset + 8), 'le');
        offset += 8;

        this.virtualSolReserves = new BN(data.subarray(offset, offset + 8), 'le');
        offset += 8;

        this.realTokenReserves = new BN(data.subarray(offset, offset + 8), 'le');
        offset += 8;

        this.realSolReserves = new BN(data.subarray(offset, offset + 8), 'le');
        offset += 8;

        this.tokenTotalSupply = new BN(data.subarray(offset, offset + 8), 'le');
        offset += 8;

        this.complete = data[offset] === 1;
        offset += 1;

        this.creator = new PublicKey(data.subarray(offset, offset + 32));
    }
    static fromBuffer(data) {
        return new BondingCurveAccount(data);
    }
}

function getCreatorVaultPDA(creator) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), creator.toBuffer()],
        new PublicKey(PUMP_FUN_PROGRAM_ID)
    )[0];
}

function getBondingCurveAddress(mint) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
        new PublicKey(PUMP_FUN_PROGRAM_ID)
    )[0];
}

function getAssociatedBondingCurveAccount(mint) {
    const bondingCurve = getBondingCurveAddress(mint);
    return PublicKey.findProgramAddressSync(
        [bondingCurve.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
}

async function getBondingCurveData(mint) {
    const bondingCurve = getBondingCurveAddress(mint);
    const accountInfo = await connection.getAccountInfo(bondingCurve);
    if (!accountInfo) {
        throw new Error("找不到bonding curve账户信息");
    }
    return BondingCurveAccount.fromBuffer(accountInfo.data);
}

function calculateTokenAmount(virtualTokenReserves, virtualSolReserves, solAmount) {
    const k = virtualTokenReserves.mul(virtualSolReserves);
    const newSolReserves = virtualSolReserves.add(solAmount);
    const newTokenReserves = k.div(newSolReserves);
    return virtualTokenReserves.sub(newTokenReserves);
}

function calculateSolAmount(virtualTokenReserves, virtualSolReserves, tokenAmount) {
    const k = virtualTokenReserves.mul(virtualSolReserves);
    const newTokenReserves = virtualTokenReserves.add(tokenAmount);
    const newSolReserves = k.div(newTokenReserves);
    return virtualSolReserves.sub(newSolReserves);
}

// 获取随机副钱包
function getRandomSubWallet() {
    const randomIndex = Math.floor(Math.random() * subWallets.length);
    return subWallets[randomIndex];
}

// 查找持有代币的副钱包
async function findTokenHolder(mint) {
    const mintPubkey = new PublicKey(mint);
    
    for (const subWallet of subWallets) {
        try {
            const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, subWallet.publicKey);
            const accountInfo = await connection.getAccountInfo(userTokenAccount);
            
            if (accountInfo) {
                const tokenAccountData = accountInfo.data;
                const amount = new BN(tokenAccountData.subarray(64, 72), 'le');
                
                if (amount.gt(new BN(0))) {
                    return {
                        wallet: subWallet,
                        tokenAccount: userTokenAccount,
                        balance: amount
                    };
                }
            }
        } catch (error) {
            console.log(`检查副钱包 ${subWallet.publicKey.toString()} 余额时出错:`, error.message);
        }
    }
    
    return null;
}

// ================================ 买入主流程 ================================

async function createBuyTransaction(
    mint,
    solAmount,
    receiverWallet,
    slippage = DEFAULT_SLIPPAGE
) {
    const bondingCurveData = await getBondingCurveData(mint);

    const solAmountLamports = new BN(solAmount * LAMPORTS_PER_SOL);
    const expectedTokens = calculateTokenAmount(
        bondingCurveData.virtualTokenReserves,
        bondingCurveData.virtualSolReserves,
        solAmountLamports
    );

    const minTokens = expectedTokens.mul(new BN(100 - slippage)).div(new BN(100));
    const maxSolCost = solAmountLamports.mul(new BN(100 + slippage)).div(new BN(100)).add(new BN(1000));

    const mintPubkey = new PublicKey(mint);
    const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, receiverWallet.publicKey);
    const bondingCurve = getBondingCurveAddress(mint);
    const associatedBondingCurve = getAssociatedBondingCurveAccount(mint);
    const creatorVault = getCreatorVaultPDA(bondingCurveData.creator);

    const transaction = new Transaction();

    // 添加优先费用
    const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: DEFAULT_PRIORITY_FEE * LAMPORTS_PER_SOL
    });
    transaction.add(priorityFeeInstruction);

    // 创建代币账户（如果不存在）
    const userTokenAccountInfo = await connection.getAccountInfo(userTokenAccount);
    if (!userTokenAccountInfo) {
        transaction.add(
            createAssociatedTokenAccountInstruction(
                mainWallet.publicKey,    // 主钱包支付创建费用
                userTokenAccount,
                receiverWallet.publicKey, // 副钱包拥有代币账户
                mintPubkey
            )
        );
    }

    // 构建买入指令
    const buyInstructionData = Buffer.alloc(24);
    buyInstructionData[0] = 102;
    buyInstructionData[1] = 6;
    buyInstructionData[2] = 61;
    buyInstructionData[3] = 18;
    buyInstructionData[4] = 1;
    buyInstructionData[5] = 218;
    buyInstructionData[6] = 235;
    buyInstructionData[7] = 234;

    const tokenBytes = expectedTokens.toArrayLike(Buffer, 'le', 8);
    const solBytes = maxSolCost.toArrayLike(Buffer, 'le', 8);

    for (let i = 0; i < 8; i++) {
        buyInstructionData[8 + i] = tokenBytes[i];
        buyInstructionData[16 + i] = solBytes[i];
    }

    const buyInstruction = new TransactionInstruction({
        programId: new PublicKey(PUMP_FUN_PROGRAM_ID),
        keys: [
            { pubkey: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"), isSigner: false, isWritable: false },
            { pubkey: new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"), isSigner: false, isWritable: true },
            { pubkey: mintPubkey, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: mainWallet.publicKey, isSigner: true, isWritable: true }, // 主钱包支付SOL
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: creatorVault, isSigner: false, isWritable: true },
            { pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(PUMP_FUN_PROGRAM_ID), isSigner: false, isWritable: false }
        ],
        data: buyInstructionData
    });

    transaction.add(buyInstruction);
    
    // 主钱包支付所有费用
    transaction.feePayer = mainWallet.publicKey;
    
    return transaction;
}

async function buyToken(
    mint,
    solAmount,
    slippage = DEFAULT_SLIPPAGE
) {
    try {
        const receiverWallet = getRandomSubWallet();
        const transaction = await createBuyTransaction(mint, solAmount, receiverWallet, slippage);
        
        // 签名交易 - 主钱包和副钱包都需要签名
        const signers = [mainWallet];
        
        // 如果需要创建代币账户，副钱包也需要签名
        const mintPubkey = new PublicKey(mint);
        const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, receiverWallet.publicKey);
        const userTokenAccountInfo = await connection.getAccountInfo(userTokenAccount);
        if (!userTokenAccountInfo) {
            signers.push(receiverWallet);
        }
        
        const signature = await connection.sendAndConfirmTransaction(transaction, signers);
        
        console.log(`✅ 买入成功! 交易: ${signature}`);
        console.log(`💰 主钱包 ${mainWallet.publicKey.toString()} 支付 ${solAmount} SOL`);
        console.log(`🎯 副钱包 ${receiverWallet.publicKey.toString()} 接收代币`);
        
        return {
            signature,
            payerWallet: mainWallet.publicKey.toString(),
            receiverWallet: receiverWallet.publicKey.toString(),
            tokenAccount: userTokenAccount.toString()
        };
    } catch (error) {
        console.error(`❌ 买入失败:`, error);
        return null;
    }
}

// ================================ 卖出主流程 ================================

async function createSellTransaction(
    mint,
    tokenAmount,
    holderWallet,
    slippage = DEFAULT_SLIPPAGE
) {
    const bondingCurveData = await getBondingCurveData(mint);

    const expectedSol = calculateSolAmount(
        bondingCurveData.virtualTokenReserves,
        bondingCurveData.virtualSolReserves,
        tokenAmount
    );

    const minSolOut = expectedSol.mul(new BN(100 - slippage)).div(new BN(100));

    const mintPubkey = new PublicKey(mint);
    const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, holderWallet.wallet.publicKey);
    const bondingCurve = getBondingCurveAddress(mint);
    const associatedBondingCurve = getAssociatedBondingCurveAccount(mint);
    const creatorVault = getCreatorVaultPDA(bondingCurveData.creator);

    const transaction = new Transaction();

    // 添加优先费用
    const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: DEFAULT_PRIORITY_FEE * LAMPORTS_PER_SOL
    });
    transaction.add(priorityFeeInstruction);

    // 构建卖出指令
    const sellInstructionData = Buffer.alloc(24);
    sellInstructionData[0] = 51;
    sellInstructionData[1] = 230;
    sellInstructionData[2] = 124;
    sellInstructionData[3] = 39;
    sellInstructionData[4] = 6;
    sellInstructionData[5] = 155;
    sellInstructionData[6] = 136;
    sellInstructionData[7] = 87;

    const tokenBytes = tokenAmount.toArrayLike(Buffer, 'le', 8);
    const solBytes = minSolOut.toArrayLike(Buffer, 'le', 8);

    for (let i = 0; i < 8; i++) {
        sellInstructionData[8 + i] = tokenBytes[i];
        sellInstructionData[16 + i] = solBytes[i];
    }

    const sellInstruction = new TransactionInstruction({
        programId: new PublicKey(PUMP_FUN_PROGRAM_ID),
        keys: [
            { pubkey: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"), isSigner: false, isWritable: false },
            { pubkey: new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"), isSigner: false, isWritable: true },
            { pubkey: mintPubkey, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: mainWallet.publicKey, isSigner: true, isWritable: true }, // 主钱包接收SOL
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: creatorVault, isSigner: false, isWritable: true },
            { pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(PUMP_FUN_PROGRAM_ID), isSigner: false, isWritable: false }
        ],
        data: sellInstructionData
    });

    transaction.add(sellInstruction);
    
    // 主钱包支付所有费用
    transaction.feePayer = mainWallet.publicKey;
    
    return transaction;
}

async function sellToken(
    mint,
    tokenAmount,
    slippage = DEFAULT_SLIPPAGE
) {
    try {
        const holderWallet = await findTokenHolder(mint);
        if (!holderWallet) {
            console.log("❌ 未找到持有该代币的副钱包");
            return null;
        }

        const sellAmount = tokenAmount || holderWallet.balance;
        const transaction = await createSellTransaction(mint, sellAmount, holderWallet, slippage);
        
        // 签名交易 - 主钱包和持有代币的副钱包都需要签名
        const signers = [mainWallet, holderWallet.wallet];
        
        const signature = await connection.sendAndConfirmTransaction(transaction, signers);
        
        console.log(`✅ 卖出成功! 交易: ${signature}`);
        console.log(`🎯 副钱包 ${holderWallet.wallet.publicKey.toString()} 卖出代币`);
        console.log(`💰 主钱包 ${mainWallet.publicKey.toString()} 接收SOL`);
        
        return {
            signature,
            sellerWallet: holderWallet.wallet.publicKey.toString(),
            receiverWallet: mainWallet.publicKey.toString(),
            tokenAmount: sellAmount.toString()
        };
    } catch (error) {
        console.error(`❌ 卖出失败:`, error);
        return null;
    }
}

// ================================ 批量操作 ================================

async function batchBuy(mint, purchases) {
    const results = [];
    
    for (const purchase of purchases) {
        try {
            await new Promise(resolve => setTimeout(resolve, 200)); // 防止过快请求
            const result = await buyToken(mint, purchase.solAmount, purchase.slippage);
            results.push(result);
        } catch (error) {
            console.error(`批量购买失败:`, error);
            results.push({ error: error.message });
        }
    }
    
    return results;
}

async function sellAllTokens(mint, slippage = DEFAULT_SLIPPAGE) {
    const results = [];
    
    // 查找所有持有代币的副钱包
    for (const subWallet of subWallets) {
        try {
            const holder = await findTokenHolder(mint);
            if (holder && holder.balance.gt(new BN(0))) {
                const result = await sellToken(mint, holder.balance, slippage);
                if (result) {
                    results.push(result);
                }
            }
        } catch (error) {
            console.error(`批量卖出失败:`, error);
            results.push({ error: error.message });
        }
    }
    
    return results;
}

// 查看投资组合
async function getPortfolio() {
    const portfolio = {};
    const mintPubkey = new PublicKey(MINT_ADDRESS);
    
    for (const subWallet of subWallets) {
        try {
            const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, subWallet.publicKey);
            const accountInfo = await connection.getAccountInfo(userTokenAccount);
            
            if (accountInfo) {
                const tokenAccountData = accountInfo.data;
                const amount = new BN(tokenAccountData.subarray(64, 72), 'le');
                
                if (amount.gt(new BN(0))) {
                    portfolio[subWallet.publicKey.toString()] = {
                        tokenAccount: userTokenAccount.toString(),
                        balance: amount.toString()
                    };
                }
            }
        } catch (error) {
            console.log(`获取副钱包 ${subWallet.publicKey.toString()} 投资组合失败:`, error.message);
        }
    }
    
    return portfolio;
}

// ================================ 运行示例 ================================
(async () => {
    if (!MAIN_WALLET_PRIVATE_KEY || !SUB_WALLET_PRIVATE_KEYS.length || !MINT_ADDRESS) {
        console.log("请填写主钱包私钥、副钱包私钥数组和代币地址");
        return;
    }

    console.log("🚀 PumpFun多钱包交易系统启动");
    console.log(`📊 主钱包: ${mainWallet.publicKey.toString()}`);
    console.log(`👥 副钱包数量: ${subWallets.length}`);
    console.log(`🎯 代币地址: ${MINT_ADDRESS}`);
    console.log("-".repeat(50));

    // 单次购买示例
    console.log("💰 开始购买代币...");
    const buyResult = await buyToken(MINT_ADDRESS, 0.001, 3); // 0.001 SOL, 3%滑点
    
    if (buyResult) {
        console.log("-".repeat(50));
        
        // 查看投资组合
        console.log("📊 查看投资组合...");
        const portfolio = await getPortfolio();
        console.log("投资组合:", portfolio);
        
        // 等待一段时间后卖出
        console.log("⏰ 等待5秒后卖出...");
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log("💸 开始卖出代币...");
        const sellResult = await sellToken(MINT_ADDRESS, null, 3); // 卖出所有代币
        
        if (sellResult) {
            console.log("-".repeat(50));
            console.log("✅ 交易流程完成!");
        }
    }

    // 批量购买示例
    /*
    console.log("🔄 批量购买示例...");
    const purchases = [
        { solAmount: 0.001, slippage: 3 },
        { solAmount: 0.002, slippage: 3 },
        { solAmount: 0.001, slippage: 3 }
    ];
    const batchResults = await batchBuy(MINT_ADDRESS, purchases);
    console.log("批量购买结果:", batchResults);
    */
})();