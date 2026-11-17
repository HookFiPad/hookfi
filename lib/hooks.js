// Uniswap v4 hook permissions: the lowest 14 bits of a hook's address.
// Pure functions, no network. The node and the browser import this same file.

export const FLAG_NAMES = [
  'beforeInitialize', 'afterInitialize', 'beforeAddLiquidity', 'afterAddLiquidity', 'beforeRemoveLiquidity', 'afterRemoveLiquidity',
  'beforeSwap', 'afterSwap', 'beforeDonate', 'afterDonate',
  'beforeSwapReturnDelta', 'afterSwapReturnDelta', 'afterAddLiquidityReturnDelta', 'afterRemoveLiquidityReturnDelta',
];
export const FLAG_CALLED = {
  beforeInitialize: 'Before a pool using the hook is created', afterInitialize: 'After a pool is created',
  beforeAddLiquidity: 'Before liquidity is added', afterAddLiquidity: 'After liquidity is added',
  beforeRemoveLiquidity: 'Before liquidity is removed', afterRemoveLiquidity: 'After liquidity is removed',
  beforeSwap: 'Before every swap', afterSwap: 'After every swap',
  beforeDonate: 'Before a donation to in-range LPs', afterDonate: 'After a donation',
  beforeSwapReturnDelta: 'beforeSwap may return a delta that changes the swap amounts',
  afterSwapReturnDelta: 'afterSwap may return a delta charged to or paid to the swapper',
  afterAddLiquidityReturnDelta: 'afterAddLiquidity may return a delta charged to the LP',
  afterRemoveLiquidityReturnDelta: 'afterRemoveLiquidity may return a delta charged to the LP',
};
export const MASK = 0x3fff;
export const DYNAMIC_FEE = 0x800000;
export const ZERO = '0x0000000000000000000000000000000000000000';

// beforeInitialize is bit 13, afterRemoveLiquidityReturnDelta is bit 0
export const FLAG_BITS = Object.fromEntries(FLAG_NAMES.map((n, i) => [n, 1 << (13 - i)]));
export const FLAG_TABLE = FLAG_NAMES.map((name, i) => ({ name, bit: 13 - i, value: 1 << (13 - i), hex: '0x' + (1 << (13 - i)).toString(16).padStart(4, '0'), called: FLAG_CALLED[name] }));

// a *ReturnDelta flag is only valid with the function that returns the delta (Hooks.isValidHookAddress)
export const REQUIRES = { beforeSwapReturnDelta: 'beforeSwap', afterSwapReturnDelta: 'afterSwap', afterAddLiquidityReturnDelta: 'afterAddLiquidity', afterRemoveLiquidityReturnDelta: 'afterRemoveLiquidity' };

export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
export const hex4 = (n) => '0x' + n.toString(16).padStart(4, '0');

// names or a mask (192, "0x00c0") -> 14-bit number
export function flagsFor(input) {
  if (typeof input === 'number') { if (!Number.isInteger(input) || input < 0 || input > MASK) throw new Error('flags must be a 14-bit mask (0 to 16383)'); return input; }
  if (typeof input === 'string') { const n = Number(input); if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(input) || !Number.isInteger(n) || n > MASK) throw new Error('flags must be permission names or a 14-bit mask'); return n; }
  if (!Array.isArray(input)) throw new Error('flags must be permission names or a 14-bit mask');
  let f = 0; for (const name of input) { if (!(name in FLAG_BITS)) throw new Error('unknown flag: ' + name); f |= FLAG_BITS[name]; } return f;
}
export const flagErrors = (flags) => Object.entries(REQUIRES).filter(([d, base]) => (flags & FLAG_BITS[d]) && !(flags & FLAG_BITS[base])).map(([d, base]) => d + ' requires ' + base);

// what each permission makes possible, most significant first
const NOTES = [
  ['warning', 'beforeSwapReturnDelta', ['beforeSwapReturnDelta'], "Can take over swap pricing (custom curve / custom accounting): output may not follow the pool's liquidity."],
  ['warning', 'afterSwapReturnDelta', ['afterSwapReturnDelta'], 'Can charge or rebate tokens after each swap, e.g. a hook fee on top of the LP fee.'],
  ['warning', 'liquidityReturnDelta', ['afterAddLiquidityReturnDelta', 'afterRemoveLiquidityReturnDelta'], 'Can take or add tokens when liquidity is added or removed.'],
  ['caution', 'beforeRemoveLiquidity', ['beforeRemoveLiquidity'], 'Runs before LP withdrawals and can revert them (lockups, vesting, or a withdrawal block).'],
  ['info', 'beforeAddLiquidity', ['beforeAddLiquidity'], 'Can gate who adds liquidity or where.'],
  ['info', 'beforeSwap', ['beforeSwap'], 'Runs before every swap: can revert, or override the LP fee on dynamic-fee pools.'],
  ['info', 'afterSwap', ['afterSwap'], 'Runs after every swap: oracles, points, limit orders, rebalancing.'],
  ['info', 'initialize', ['beforeInitialize', 'afterInitialize'], 'Runs when a pool is created with this hook (can restrict which pools use it).'],
  ['info', 'donate', ['beforeDonate', 'afterDonate'], 'Runs on donations to in-range LPs.'],
];
export const capabilities = (flags) => NOTES.filter(([, , bits]) => bits.some((b) => flags & FLAG_BITS[b])).map(([level, flag, , note]) => ({ level, flag, note }));
// the flags whose note is at warning level (the registry's short form)
export const warningFlags = (flags) => ['beforeSwapReturnDelta', 'afterSwapReturnDelta', 'afterAddLiquidityReturnDelta', 'afterRemoveLiquidityReturnDelta'].filter((n) => flags & FLAG_BITS[n]);

export function decodeFlags(flags) {
  const permissions = Object.fromEntries(FLAG_NAMES.map((n) => [n, !!(flags & FLAG_BITS[n])]));
  return { flags, flagsHex: hex4(flags), enabled: FLAG_NAMES.filter((n) => permissions[n]), permissions, errors: flagErrors(flags), capabilities: capabilities(flags) };
}
export function decodeHookAddress(address) {
  if (!isAddress(address)) throw new Error('not an address: ' + address);
  return { address, ...decodeFlags(parseInt(address.slice(-4), 16) & MASK) };
}
