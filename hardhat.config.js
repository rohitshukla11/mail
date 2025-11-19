require('dotenv').config()

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: '0.8.23',
  networks: {
    calibration: {
      url: process.env.ETH_RPC_URL ?? 'https://api.calibration.node.glif.io/rpc/v1',
      chainId: 314159,
      accounts: process.env.WALLET_PRIVATE_KEY ? [process.env.WALLET_PRIVATE_KEY] : [],
    },
  },
}

