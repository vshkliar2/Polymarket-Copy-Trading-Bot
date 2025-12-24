# Polymarket Copy Trading Bot

<div align="center">

**Automated copy trading bot for Polymarket that mirrors trades from top performers with intelligent position sizing and real-time execution.**

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-8.9-green.svg)](https://www.mongodb.com/)

[Features](#-features) • [Quick Start](#-quick-start) • [Documentation](#-documentation) • [Support](#-support)

</div>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [How It Works](#-how-it-works)
- [Features](#-features)
- [Quick Start](#-quick-start)
- [Configuration](#-configuration)
- [Docker Deployment](#-docker-deployment)
- [Documentation](#-documentation)
- [Advanced Version](#-advanced-version)
- [License](#-license)
- [Acknowledgments](#-acknowledgments)

---

## 🎯 Overview

The Polymarket Copy Trading Bot is an enterprise-grade automated trading solution that replicates trades from successful Polymarket traders directly to your wallet. The system provides continuous 24/7 monitoring, intelligent position sizing calculations, and real-time order execution with comprehensive trade tracking.

### Key Capabilities

- **Automated Trade Replication**: Seamlessly mirrors trades from selected top-performing traders
- **Intelligent Position Sizing**: Dynamically calculates trade sizes based on capital ratios
- **Real-Time Execution**: Monitors and executes trades with sub-second latency
- **Comprehensive Tracking**: Maintains complete trade history and performance analytics

---

## 🔄 How It Works

<div align="center">

<img width="995" height="691" alt="Polymarket Copy Trading Bot Workflow" src="https://github.com/user-attachments/assets/79715c7a-de2c-4033-81e6-b2288963ec9b" />

</div>

### Process Flow

1. **Trader Selection**
   - Identify top performers from the [Polymarket Leaderboard](https://polymarket.com/leaderboard)
   - Validate trader statistics using [Predictfolio](https://predictfolio.com)
   - Configure trader addresses in the system

2. **Continuous Monitoring**
   - Bot monitors trader activity using the Polymarket Data API
   - Detects new positions and trade executions in real-time
   - Polls at configurable intervals (default: 1 second)

3. **Intelligent Calculation**
   - Analyzes trader's order size and portfolio value
   - Calculates proportional position size based on your capital
   - Applies configured multipliers and risk management rules

4. **Order Execution**
   - Places matching orders on Polymarket using your wallet
   - Implements price protection and slippage checks
   - Handles order aggregation for optimal execution

5. **Performance Tracking**
   - Maintains comprehensive trade history in MongoDB
   - Tracks positions, P&L, and performance metrics
   - Provides detailed analytics and reporting

---

## ✨ Features

### Core Functionality

| Feature | Description |
|---------|-------------|
| **Multi-Trader Support** | Track and copy trades from multiple traders simultaneously with independent configuration |
| **Smart Position Sizing** | Automatically adjusts trade sizes based on your capital relative to trader's capital |
| **Tiered Multipliers** | Apply different multipliers based on trade size ranges for sophisticated risk management |
| **Position Tracking** | Accurately tracks purchases and sells even after balance changes with historical context |
| **Trade Aggregation** | Combines multiple small trades into larger executable orders to optimize execution |
| **Real-Time Execution** | Monitors trades every second and executes instantly with minimal latency |
| **MongoDB Integration** | Persistent storage of all trades, positions, and historical data |
| **Price Protection** | Built-in slippage checks and price validation to avoid unfavorable fills |

### Technical Specifications

- **Monitoring Method**: Polymarket Data API with configurable polling intervals
- **Default Polling Interval**: 1 second (configurable via `FETCH_INTERVAL`)
- **Database**: MongoDB for persistent storage and analytics
- **Network**: Polygon blockchain for low-cost transactions
- **Architecture**: TypeScript-based modular design with comprehensive error handling

---

## 🚀 Quick Start

### Prerequisites

Before you begin, ensure you have the following:

- **Node.js** v18.0.0 or higher
- **MongoDB Database** ([MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) free tier recommended)
- **Polygon Wallet** with USDC and POL/MATIC for gas fees
- **RPC Endpoint** ([Infura](https://infura.io) or [Alchemy](https://www.alchemy.com) free tier)

### Installation Steps

```bash
# 1. Clone the repository
git clone https://github.com/earthskyorg/polymarket-copy-trading-bot.git
cd polymarket-copy-trading-bot

# 2. Install dependencies
npm install

# 3. Run interactive setup wizard
npm run setup

# 4. Build the project
npm run build

# 5. Verify configuration
npm run health-check

# 6. Start the bot
npm start
```

> **📖 Detailed Setup**: For comprehensive setup instructions, see the [Getting Started Guide](./docs/GETTING_STARTED.md)

---

## ⚙️ Configuration

### Essential Environment Variables

The following environment variables are required for the bot to function:

| Variable | Description | Example |
|----------|-------------|---------|
| `USER_ADDRESSES` | Comma-separated list of trader addresses to copy | `'0xABC..., 0xDEF...'` |
| `PROXY_WALLET` | Your Polygon wallet address | `'0x123...'` |
| `PRIVATE_KEY` | Wallet private key (without 0x prefix) | `'abc123...'` |
| `MONGO_URI` | MongoDB connection string | `'mongodb+srv://...'` |
| `RPC_URL` | Polygon RPC endpoint URL | `'https://polygon...'` |
| `TRADE_MULTIPLIER` | Position size multiplier (default: 1.0) | `2.0` |
| `FETCH_INTERVAL` | Monitoring interval in seconds (default: 1) | `1` |

### Finding Quality Traders

To identify traders worth copying, follow these steps:

1. **Visit the Leaderboard**: Navigate to [Polymarket Leaderboard](https://polymarket.com/leaderboard)
2. **Evaluate Performance**: Look for traders with:
   - Positive P&L over extended periods
   - Win rate above 55%
   - Active and consistent trading history
3. **Verify Statistics**: Cross-reference detailed stats on [Predictfolio](https://predictfolio.com)
4. **Configure**: Add verified wallet addresses to `USER_ADDRESSES` in your configuration

> **📖 Complete Configuration Guide**: See [Quick Start Documentation](./docs/QUICK_START.md) for detailed configuration options

---

## 🐳 Docker Deployment

Deploy the bot using Docker Compose for a production-ready, containerized setup:

```bash
# 1. Configure environment variables
cp .env.example .env
# Edit .env with your configuration

# 2. Start services
docker-compose up -d

# 3. View logs
docker-compose logs -f bot
```

### Docker Features

- **Isolated Environment**: Runs in a containerized environment
- **Automatic Restart**: Configured for automatic restart on failure
- **MongoDB Integration**: Includes MongoDB service in the stack
- **Health Checks**: Built-in health monitoring

> **📖 Docker Documentation**: For complete Docker setup and configuration, see [Docker Deployment Guide](./docs/DOCKER.md)

---

## 📚 Documentation

### Getting Started Guides

- **[🚀 Getting Started Guide](./docs/GETTING_STARTED.md)** - Comprehensive beginner's guide with step-by-step instructions
- **[⚡ Quick Start Guide](./docs/QUICK_START.md)** - Fast setup guide for experienced users

### Additional Resources

- **[Docker Guide](./docs/DOCKER.md)** - Complete Docker deployment documentation
- **[Multi-Trader Guide](./docs/MULTI_TRADER_GUIDE.md)** - Managing multiple traders
- **[Tiered Multipliers](./docs/TIERED_MULTIPLIERS.md)** - Advanced position sizing configuration
- **[Position Tracking](./docs/POSITION_TRACKING.md)** - Understanding position management

---

## 🚀 Advanced Version

### Version 2.0 - RTDS (Real-Time Data Stream)

An advanced version with **Real-Time Data Stream (RTDS)** monitoring is available as a private repository.

#### Enhanced Features

- **Fastest Trade Detection**: Near-instantaneous trade replication
- **Reduced Latency**: Optimized for minimal execution delay
- **Lower API Load**: More efficient data streaming architecture
- **Superior Performance**: Enhanced copy trading capabilities

<div align="center">

<img width="680" height="313" alt="Version 2 RTDS Features" src="https://github.com/user-attachments/assets/d868f9f2-a1dd-4bfe-a76e-d8cbdfbd8497" />

</div>

---

## 🛠️ Trading Tool

A high-performance trading bot for Polymarket built with **Rust** is also available.

<div align="center">

<img width="1917" height="942" alt="Rust Trading Bot" src="https://github.com/user-attachments/assets/08a5c962-7f8b-4097-98b6-7a457daa37c9" />

[Watch Demo Video](https://www.youtube.com/watch?v=0uUI_ht_2eY)

</div>

---

## 📄 License

This project is licensed under the **ISC License**. See the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

This project is built using the following technologies and services:

- **[Polymarket CLOB Client](https://github.com/Polymarket/clob-client)** - Official Polymarket trading client library
- **[Predictfolio](https://predictfolio.com)** - Trader analytics and performance metrics
- **Polygon Network** - Low-cost blockchain infrastructure

---

## 💬 Support

For questions, issues, or feature requests:

- **Telegram**: [@opensea712](https://t.me/opensea712)
- **Twitter**: [@shinytechapes](https://x.com/shinytechapes)

---

<div align="center">

**Built with ❤️ for the Polymarket community**

[⬆ Back to Top](#polymarket-copy-trading-bot)

</div>
