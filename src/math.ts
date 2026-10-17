/**
 * QMOOSA Derivatives Protocol — Invariant Mathematics & Perpetual Futures Engine
 *
 * Implements:
 * 1. Fixed-point (WAD = 1e18) notional and margin accounting
 * 2. Position PnL calculations for both Long and Short legs
 * 3. Maintenance margin thresholds and margin ratio calculation
 * 4. Exact liquidation price derivation preventing bad debt
 * 5. Dynamic 8-hour funding rate calculation with bounds clamping
 * 6. Funding payment settlement invariant
 */

export const WAD = 10n ** 18n;
export const BPS_DIVISOR = 10_000n;
export const MAX_LEVERAGE = 20n;
export const MIN_LEVERAGE = 1n;
export const DEFAULT_MAINTENANCE_MARGIN_BPS = 500n; // 5.00%
export const MAX_FUNDING_RATE_BPS = 500n; // +/- 5.00% cap

export interface PositionState {
  isLong: boolean;
  size: bigint; // Base asset quantity in WAD (e.g. 1 ETH = 1e18)
  collateral: bigint; // Quote asset collateral in WAD (e.g. 100 USDC = 100e18)
  entryPrice: bigint; // Entry price in WAD (e.g. 2000 USD = 2000e18)
  accruedFunding: bigint; // Cumulative funding owed/paid (+ means owed, - means credited)
}

/**
 * Calculates notional value of a position in quote asset: (size * price) / WAD
 */
export function calculateNotional(size: bigint, price: bigint): bigint {
  if (size <= 0n) throw new RangeError("Position size must be strictly positive");
  if (price <= 0n) throw new RangeError("Price must be strictly positive");
  return (size * price) / WAD;
}

/**
 * Calculates required initial margin for a given notional and leverage.
 */
export function calculateInitialMargin(notional: bigint, leverage: bigint): bigint {
  if (notional <= 0n) throw new RangeError("Notional must be strictly positive");
  if (leverage < MIN_LEVERAGE || leverage > MAX_LEVERAGE) {
    throw new RangeError(`Leverage must be between ${MIN_LEVERAGE}x and ${MAX_LEVERAGE}x (got ${leverage}x)`);
  }
  return notional / leverage;
}

/**
 * Calculates maintenance margin requirement in quote asset.
 */
export function calculateMaintenanceMargin(
  notional: bigint,
  maintenanceMarginBps: bigint = DEFAULT_MAINTENANCE_MARGIN_BPS
): bigint {
  if (notional <= 0n) throw new RangeError("Notional must be strictly positive");
  return (notional * maintenanceMarginBps) / BPS_DIVISOR;
}

/**
 * Calculates unrealized PnL based on position direction, size, entry price, and current mark price.
 */
export function calculateUnrealizedPnl(
  isLong: boolean,
  size: bigint,
  entryPrice: bigint,
  markPrice: bigint
): bigint {
  if (size <= 0n) throw new RangeError("Position size must be strictly positive");
  if (entryPrice <= 0n || markPrice <= 0n) throw new RangeError("Prices must be strictly positive");

  if (isLong) {
    // PnL = size * (markPrice - entryPrice) / WAD
    return (size * (markPrice - entryPrice)) / WAD;
  } else {
    // PnL = size * (entryPrice - markPrice) / WAD
    return (size * (entryPrice - markPrice)) / WAD;
  }
}

/**
 * Calculates current equity: collateral + unrealizedPnl - accruedFunding.
 */
export function calculateEquity(position: PositionState, markPrice: bigint): bigint {
  const pnl = calculateUnrealizedPnl(position.isLong, position.size, position.entryPrice, markPrice);
  return position.collateral + pnl - position.accruedFunding;
}

/**
 * Calculates margin ratio in basis points: (equity * BPS_DIVISOR) / notional.
 */
export function calculateMarginRatio(equity: bigint, notional: bigint): bigint {
  if (notional <= 0n) throw new RangeError("Notional must be strictly positive");
  if (equity <= 0n) return 0n;
  return (equity * BPS_DIVISOR) / notional;
}

/**
 * Determines whether a position has breached maintenance margin and must be liquidated.
 */
export function isLiquidatable(
  position: PositionState,
  markPrice: bigint,
  maintenanceMarginBps: bigint = DEFAULT_MAINTENANCE_MARGIN_BPS
): boolean {
  const equity = calculateEquity(position, markPrice);
  const notional = calculateNotional(position.size, markPrice);
  const maintenanceMargin = calculateMaintenanceMargin(notional, maintenanceMarginBps);
  return equity <= maintenanceMargin;
}

/**
 * Derives exact liquidation price where equity equals maintenance margin.
 */
export function calculateLiquidationPrice(
  isLong: boolean,
  size: bigint,
  entryPrice: bigint,
  collateral: bigint,
  maintenanceMarginBps: bigint = DEFAULT_MAINTENANCE_MARGIN_BPS
): bigint {
  if (size <= 0n) throw new RangeError("Position size must be strictly positive");
  if (entryPrice <= 0n) throw new RangeError("Entry price must be strictly positive");
  if (collateral <= 0n) throw new RangeError("Collateral must be strictly positive");

  if (isLong) {
    // equity = collateral + size * (P_liq - entryPrice) / WAD = (size * P_liq * mmBps) / (WAD * BPS_DIVISOR)
    // P_liq * size * (1 - mmBps/BPS_DIVISOR) / WAD = (size * entryPrice)/WAD - collateral
    // P_liq = ((size * entryPrice) - (collateral * WAD)) * BPS_DIVISOR / (size * (BPS_DIVISOR - mmBps))
    const notionalEntry = (size * entryPrice);
    const collateralScaled = collateral * WAD;
    if (collateralScaled >= notionalEntry) {
      // 100%+ collateralized, cannot be liquidated above zero
      return 0n;
    }
    const numerator = (notionalEntry - collateralScaled) * BPS_DIVISOR;
    const denominator = size * (BPS_DIVISOR - maintenanceMarginBps);
    return numerator / denominator;
  } else {
    // For short:
    // equity = collateral + size * (entryPrice - P_liq) / WAD = (size * P_liq * mmBps) / (WAD * BPS_DIVISOR)
    // collateral + (size * entryPrice)/WAD = P_liq * size * (1 + mmBps/BPS_DIVISOR) / WAD
    // P_liq = ((size * entryPrice) + (collateral * WAD)) * BPS_DIVISOR / (size * (BPS_DIVISOR + maintenanceMarginBps))
    // Use ceiling division so that at P_liq, the position is guaranteed to be liquidatable
    const numerator = ((size * entryPrice) + (collateral * WAD)) * BPS_DIVISOR;
    const denominator = size * (BPS_DIVISOR + maintenanceMarginBps);
    return (numerator + denominator - 1n) / denominator;
  }
}

/**
 * Calculates dynamic funding rate in BPS based on mark price vs index price.
 * Clamped between -maxFundingBps and +maxFundingBps.
 */
export function calculateFundingRate(
  markPrice: bigint,
  indexPrice: bigint,
  maxFundingBps: bigint = MAX_FUNDING_RATE_BPS
): bigint {
  if (markPrice <= 0n || indexPrice <= 0n) throw new RangeError("Prices must be strictly positive");
  // premium = (markPrice - indexPrice) * BPS_DIVISOR / indexPrice
  const premiumBps = ((markPrice - indexPrice) * BPS_DIVISOR) / indexPrice;
  if (premiumBps > maxFundingBps) return maxFundingBps;
  if (premiumBps < -maxFundingBps) return -maxFundingBps;
  return premiumBps;
}

/**
 * Calculates funding payment for a position: (notional * fundingRateBps) / BPS_DIVISOR
 * Positive result = position holder pays funding.
 * Negative result = position holder receives funding.
 */
export function calculateFundingPayment(
  isLong: boolean,
  notional: bigint,
  fundingRateBps: bigint
): bigint {
  if (notional <= 0n) throw new RangeError("Notional must be strictly positive");
  const rawPayment = (notional * fundingRateBps) / BPS_DIVISOR;
  return isLong ? rawPayment : -rawPayment;
}
