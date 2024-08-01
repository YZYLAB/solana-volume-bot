require("dotenv").config();
const { SolanaTracker } = require("solana-swap");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const { keys } = require("./keys");
const winston = require('winston');
const chalk = require('chalk');

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'volume-bot.log' })
  ]
});

class VolumeBot {
  constructor() {
    this.config = {
      amount: parseFloat(process.env.AMOUNT),
      tokenAddress: process.env.TOKEN_ADDRESS,
      delay: parseInt(process.env.DELAY),
      sellDelay: parseInt(process.env.SELL_DELAY),
      slippage: parseInt(process.env.SLIPPAGE),
      priorityFee: parseFloat(process.env.PRIORITY_FEE),
      useJito: process.env.JITO === "true",
      rpcUrl: process.env.RPC_URL,
      threads: parseInt(process.env.THREADS) || 1
    };
    this.keys = keys;
    this.SOL_ADDRESS = "So11111111111111111111111111111111111111112";
    this.activeWallets = new Set();
  }

  getAvailableKeypair() {
    let keypair;
    do {
      const privateKey = this.keys[Math.floor(Math.random() * this.keys.length)];
      keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    } while (this.activeWallets.has(keypair.publicKey.toBase58()));

    this.activeWallets.add(keypair.publicKey.toBase58());
    return keypair;
  }

  release(publicKey) {
    this.activeWallets.delete(publicKey);
  }

  async performSwap(solanaTracker, keypair, isBuy) {
    logger.info(`${isBuy ? chalk.white('[BUYING]') : chalk.white('[SELLING]')} [${keypair.publicKey.toBase58()}] Initiating swap`);
    const { amount, tokenAddress, slippage, priorityFee } = this.config;
    const [fromToken, toToken] = isBuy
      ? [this.SOL_ADDRESS, tokenAddress]
      : [tokenAddress, this.SOL_ADDRESS];

    try {
      const swapResponse = await solanaTracker.getSwapInstructions(
        fromToken,
        toToken,
        isBuy ? amount : "auto",
        slippage,
        keypair.publicKey.toBase58(),
        priorityFee
      );

      const swapOptions = this.buildSwapOptions();
      const txid = await solanaTracker.performSwap(swapResponse, swapOptions);
      this.logTransaction(txid, isBuy);
      return txid;
    } catch (error) {
      logger.error(`Error performing ${isBuy ? "buy" : "sell"}: ${error.message}`, { error });
      return false;
    }
  }

  buildSwapOptions() {
    return {
      sendOptions: { skipPreflight: true },
      confirmationRetries: 30,
      confirmationRetryTimeout: 1000,
      lastValidBlockHeightBuffer: 150,
      resendInterval: 1000,
      confirmationCheckInterval: 1000,
      commitment: "processed",
      jito: this.config.useJito ? { enabled: true, tip: 0.0001 } : undefined,
    };
  }

  async swap(solanaTracker, keypair) {
    const buyTxid = await this.performSwap(solanaTracker, keypair, true);
    if (buyTxid) {
      await sleep(this.config.sellDelay);
      const sellTxid = await this.performSwap(solanaTracker, keypair, false);
      return sellTxid;
    }
    return false;
  }

  logTransaction(txid, isBuy) {
    logger.info(`${isBuy ? chalk.green('[BOUGHT]') : chalk.red('[SOLD]')} [${txid}]`);
  }

  async run() {
    while (true) {
      const keypair = this.getAvailableKeypair();
      const solanaTracker = new SolanaTracker(keypair, this.config.rpcUrl);

      await this.swap(solanaTracker, keypair);
      this.release(keypair.publicKey.toBase58());
      await sleep(this.config.delay);
    }
  }

  async start() {
    logger.info('Starting Volume Bot');
    const walletPromises = [];
    const availableThreads = Math.min(this.config.threads, this.keys.length);
    for (let i = 0; i < availableThreads; i++) {
      walletPromises.push(this.run());
    }
    await Promise.all(walletPromises);
  }
}

const bot = new VolumeBot();
bot.start().catch(error => logger.error('Error in bot execution', { error }));