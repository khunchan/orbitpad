// Adapted from AmmoraLabs/ammora-examples src/launch/config-from-template.ts (MIT License, (c) 2026 Ammora Labs).
import {
  AmmoraV4MigrationMode,
  assertAmmoraV4Config,
  buildSingleSegmentCurve,
  concentratedDepositQuote,
  type AmmoraV4Config,
  type AmmoraV4ConfigSnapshot,
  type AmmoraV4Segment,
} from "@ammora-protocol/sdk";

/** Derives a registry-valid Config from a reviewed template with a new sale supply and graduation threshold. */
export const deriveConfigFromTemplate = (
  template: Pick<AmmoraV4ConfigSnapshot, "config">,
  saleSupply: bigint,
  migrationQuoteThreshold: bigint,
): { config: AmmoraV4Config; curve: readonly AmmoraV4Segment[] } => {
  if (saleSupply <= 0n || migrationQuoteThreshold <= 0n) throw new RangeError("sale supply and quote threshold must be positive");
  if (template.config.migrationMode !== AmmoraV4MigrationMode.Concentrated) {
    throw new RangeError("template must use concentrated graduation");
  }
  const curve = buildSingleSegmentCurve(template.config.startSqrtPrice, saleSupply, migrationQuoteThreshold);
  const segment = curve[0];
  if (!segment) throw new Error("single-segment curve construction returned no segment");
  const range = {
    sqrtPriceX64: segment.upperSqrtPrice,
    sqrtMinPriceX64: segment.lowerSqrtPrice,
    sqrtMaxPriceX64: segment.upperSqrtPrice * 2n,
  };
  const quoteFee = migrationQuoteThreshold * BigInt(template.config.migrationQuoteFeeBps) / 10_000n;
  const destination = concentratedDepositQuote(range, { quoteAmount: migrationQuoteThreshold - quoteFee });
  const vesting = template.config.lockedBaseVesting;
  const lockedBase = vesting.cliffUnlockAmount + vesting.amountPerPeriod * BigInt(vesting.numberOfPeriods);
  const config: AmmoraV4Config = {
    ...template.config,
    totalSupply: saleSupply + destination.baseAmount + lockedBase,
    migrationQuoteThreshold,
    migrationBaseThreshold: destination.baseAmount,
    postMigrationSqrtMinPrice: range.sqrtMinPriceX64,
    postMigrationSqrtMaxPrice: range.sqrtMaxPriceX64,
    postMigrationLiquidity: destination.liquidity,
  };
  assertAmmoraV4Config(config, curve);
  return { config, curve };
};
