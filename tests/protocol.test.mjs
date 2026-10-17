import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WAD,
  BPS_DIVISOR,
  MAX_LEVERAGE,
  MIN_LEVERAGE,
  DEFAULT_MAINTENANCE_MARGIN_BPS,
  calculateNotional,
  calculateInitialMargin,
  calculateMaintenanceMargin,
  calculateUnrealizedPnl,
  calculateEquity,
  calculateMarginRatio,
  isLiquidatable,
  calculateLiquidationPrice,
  calculateFundingRate,
  calculateFundingPayment
} from "../dist/index.js";

test("1. Notional and Initial Margin calculations with leverage constraints", () => {
  // 2 ETH at $3,000 = $6,000 notional
  const size = 2n * WAD;
  const price = 3000n * WAD;
  const notional = calculateNotional(size, price);
  assert.equal(notional, 6000n * WAD);

  // 10x leverage requires 1/10th margin = $600
  const initialMargin = calculateInitialMargin(notional, 10n);
  assert.equal(initialMargin, 600n * WAD);

  // 5% maintenance margin on $6,000 = $300
  const mm = calculateMaintenanceMargin(notional);
  assert.equal(mm, 300n * WAD);
});

test("2. Long position PnL and liquidation price derivation", () => {
  const size = 1n * WAD; // 1 ETH
  const entryPrice = 3000n * WAD; // $3,000
  const collateral = 300n * WAD; // 10x leverage ($300 margin)
  
  // Mark price rises to $3,300 (+10% gain -> +$300 profit)
  const pnlGain = calculateUnrealizedPnl(true, size, entryPrice, 3300n * WAD);
  assert.equal(pnlGain, 300n * WAD);

  // Mark price drops to $2,800 (-$200 loss)
  const pnlLoss = calculateUnrealizedPnl(true, size, entryPrice, 2800n * WAD);
  assert.equal(pnlLoss, -200n * WAD);

  // Liquidation Price calculation:
  // Notional = 3000, collateral = 300, mm = 5% (500 bps)
  // numerator = (3000 - 300) * 10000 = 2700 * 10000 = 27,000,000
  // denominator = 1 * (10000 - 500) = 9500
  // P_liq = 27,000,000 / 9500 = ~2842.10526...
  const liqPrice = calculateLiquidationPrice(true, size, entryPrice, collateral);
  assert.ok(liqPrice > 2840n * WAD && liqPrice < 2845n * WAD);

  // Verify at liquidation price: equity <= maintenance margin
  const position = {
    isLong: true,
    size,
    collateral,
    entryPrice,
    accruedFunding: 0n
  };

  assert.equal(isLiquidatable(position, 2900n * WAD), false);
  assert.equal(isLiquidatable(position, liqPrice), true);
  assert.equal(isLiquidatable(position, 2800n * WAD), true);
});

test("3. Short position PnL and liquidation price derivation", () => {
  const size = 1n * WAD;
  const entryPrice = 3000n * WAD;
  const collateral = 300n * WAD;

  // Mark price drops to $2,700 (+10% gain -> +$300 profit for short)
  const pnlGain = calculateUnrealizedPnl(false, size, entryPrice, 2700n * WAD);
  assert.equal(pnlGain, 300n * WAD);

  // Mark price rises to $3,200 (-$200 loss for short)
  const pnlLoss = calculateUnrealizedPnl(false, size, entryPrice, 3200n * WAD);
  assert.equal(pnlLoss, -200n * WAD);

  // Liquidation Price for short:
  // numerator = (3000 + 300) * 10000 = 3300 * 10000 = 33,000,000
  // denominator = 1 * (10000 + 500) = 10500
  // P_liq = 33,000,000 / 10500 = ~3142.857...
  const liqPrice = calculateLiquidationPrice(false, size, entryPrice, collateral);
  assert.ok(liqPrice > 3140n * WAD && liqPrice < 3145n * WAD);

  const position = {
    isLong: false,
    size,
    collateral,
    entryPrice,
    accruedFunding: 0n
  };

  assert.equal(isLiquidatable(position, 3100n * WAD), false);
  assert.equal(isLiquidatable(position, liqPrice), true);
  assert.equal(isLiquidatable(position, 3200n * WAD), true);
});

test("4. Dynamic funding rate calculation and clamping", () => {
  const indexPrice = 3000n * WAD;

  // Mark price at $3,030 (+1.00% premium = +100 bps)
  const fundingRate1 = calculateFundingRate(3030n * WAD, indexPrice);
  assert.equal(fundingRate1, 100n);

  // Extreme premium: Mark price at $3,300 (+10.00% premium), clamped to MAX (+500 bps)
  const fundingClampedHigh = calculateFundingRate(3300n * WAD, indexPrice);
  assert.equal(fundingClampedHigh, 500n);

  // Extreme discount: Mark price at $2,700 (-10.00% discount), clamped to MIN (-500 bps)
  const fundingClampedLow = calculateFundingRate(2700n * WAD, indexPrice);
  assert.equal(fundingClampedLow, -500n);

  // Funding payment: Long pays positive rate
  const notional = 3000n * WAD;
  const paymentLong = calculateFundingPayment(true, notional, 100n);
  // (3000 * 100) / 10000 = 30 USDC
  assert.equal(paymentLong, 30n * WAD);

  // Short receives positive rate (negative payment)
  const paymentShort = calculateFundingPayment(false, notional, 100n);
  assert.equal(paymentShort, -30n * WAD);
});

test("5. Fail-closed negative control tests (excessive leverage, zero bounds)", () => {
  assert.throws(() => calculateInitialMargin(1000n * WAD, 25n), /between 1x and 20x/);
  assert.throws(() => calculateInitialMargin(1000n * WAD, 0n), /between 1x and 20x/);
  assert.throws(() => calculateNotional(0n, 1000n * WAD), /strictly positive/);
  assert.throws(() => calculateUnrealizedPnl(true, 10n, 0n, 100n), /strictly positive/);
  assert.throws(() => calculateLiquidationPrice(true, 0n, 100n, 50n), /strictly positive/);
});
