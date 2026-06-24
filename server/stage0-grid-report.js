const TEMPLATES_PATH = './kol-templates.json';

const TARGETS = {
  pro: {
    review: {
      bullish: { stock: 20, sector: 18, futures: 12 },
      bearish: { stock: 20, sector: 18, futures: 12 },
      neutral: { stock: 16, sector: 14, futures: 10 },
    },
    independent: {
      bullish: { sector: 20, market: 12, futures: 12, futures_track: 12, fund_sector: 12 },
      bearish: { sector: 20, market: 12, futures: 12, futures_track: 12, fund_sector: 12 },
    },
  },
  semi: {
    review: {
      bullish: { stock: 20, sector: 20, futures: 12 },
      bearish: { stock: 20, sector: 20, futures: 12 },
      neutral: { stock: 16, sector: 16, futures: 10 },
    },
    independent: {
      bullish: { sector: 20, market: 12, futures: 12, futures_track: 12, fund_sector: 12 },
      bearish: { sector: 20, market: 12, futures: 12, futures_track: 12, fund_sector: 12 },
    },
  },
  grass: {
    review: {
      bullish: { stock: 22, sector: 20, futures: 16 },
      bearish: { stock: 22, sector: 20, futures: 16 },
    },
    independent: {
      bullish: { sector: 16, market: 14, futures: 14, futures_track: 14, fund_sector: 14 },
      bearish: { sector: 16, market: 14, futures: 14, futures_track: 14, fund_sector: 14 },
    },
  },
};

function reachable(target) {
  if (target !== undefined) return true;
  return false;
}

function main() {
  const data = require(TEMPLATES_PATH);
  const tt = data.tier_templates || {};
  const tiers = ['pro', 'semi', 'grass'];

  let totalGrids = 0;
  let totalCurrent = 0;
  let totalTarget = 0;
  let totalShortage = 0;
  const zeroGrids = [];
  const overGrids = [];

  const rows = [];

  for (const tier of tiers) {
    const tierTargets = TARGETS[tier] || {};
    const tierData = tt[tier] || {};

    for (const type of ['review', 'independent']) {
      const typeTargets = tierTargets[type] || {};
      const typeData = tierData[type] || {};

      for (const stance of Object.keys(typeTargets)) {
        const stanceTargets = typeTargets[stance];
        const stanceData = typeData[stance] || {};

        for (const scope of Object.keys(stanceTargets)) {
          const target = stanceTargets[scope];
          const current = Array.isArray(stanceData[scope]) ? stanceData[scope].length : 0;
          const shortage = target - current;

          totalGrids++;
          totalCurrent += current;
          totalTarget += target;
          totalShortage += shortage;

          rows.push({ tier, type, stance, scope, current, target, shortage });

          if (current === 0) {
            zeroGrids.push(`${tier}/${type}/${stance}/${scope}`);
          }
          if (shortage < 0) {
            overGrids.push(`${tier}/${type}/${stance}/${scope} (current=${current}, target=${target}, surplus=${-shortage})`);
          }
        }
      }
    }
  }

  const status = (s) => {
    if (s === 0) return '--- ZERO';
    if (s < 0) return `--- SURPLUS ${-s}`;
    return '';
  };

  console.log('Stage 0: KOL Template Grid Report');
  console.log('='.repeat(88));
  console.log(
    'tier   type         stance    scope          current  target  shortage'
  );
  console.log('-'.repeat(88));

  for (const r of rows) {
    const shortage = r.target - r.current;
    console.log(
      `${r.tier.padEnd(6)} ${r.type.padEnd(12)} ${r.stance.padEnd(10)} ${r.scope.padEnd(14)} ${String(r.current).padEnd(8)} ${String(r.target).padEnd(7)} ${String(shortage).padEnd(5)} ${status(shortage)}`
    );
  }

  console.log('-'.repeat(88));
  console.log(`Total grids:         ${totalGrids}`);
  console.log(`Total current:       ${totalCurrent}`);
  console.log(`Total target:        ${totalTarget}`);
  console.log(`Total shortage:      ${totalShortage}`);
  console.log('='.repeat(88));

  if (zeroGrids.length > 0) {
    console.log(`\n⚠  ZERO-TEMPLATE GRIDS (${zeroGrids.length} — would trigger fallbackText):`);
    for (const g of zeroGrids) console.log(`   ${g}`);
  }

  if (overGrids.length > 0) {
    console.log(`\n⚠  OVER-TARGET GRIDS (${overGrids.length} — current exceeds target):`);
    for (const g of overGrids) console.log(`   ${g}`);
  }
}

main();
