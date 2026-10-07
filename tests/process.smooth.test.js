import { test, assert, assertArrayClose, assertThrows } from './harness.js';
import { sgCoefficients, savitzkyGolay } from '../js/process/smooth.js';

// scipy.signal.savgol_coeffs(window, order, deriv, use='dot'), SciPy 1.18.1
const SCIPY = {
  '5,2,0': [-0.08571428571428569, 0.34285714285714264, 0.4857142857142855, 0.34285714285714275, -0.08571428571428573],
  '7,3,0': [-0.09523809523809523, 0.14285714285714313, 0.28571428571428586, 0.3333333333333335, 0.2857142857142857, 0.1428571428571428, -0.09523809523809514],
  '11,3,0': [-0.08391608391608424, 0.02097902097902106, 0.10256410256410292, 0.16083916083916133, 0.19580419580419633, 0.20745920745920804, 0.19580419580419633, 0.16083916083916128, 0.10256410256410284, 0.020979020979021018, -0.08391608391608417],
  '9,4,1': [0.07239057239057238, -0.11952861952861961, -0.16245791245791247, -0.10606060606060612, -5.898059818321144e-17, 0.10606060606060604, 0.16245791245791247, 0.11952861952861955, -0.07239057239057246],
  '7,2,2': [0.11904761904761904, -6.938893903907228e-18, -0.07142857142857137, -0.09523809523809522, -0.0714285714285714, 2.0816681711721685e-17, 0.11904761904761907],
};
const Y = [0.3, 1.1, 0.4, 2.2, 3.9, 5.1, 4.4, 6.8, 7.0, 5.5, 4.1, 4.9, 3.2, 2.5, 2.9, 1.0, 0.7, 1.6, 0.2, 0.9];
// scipy.signal.savgol_filter(Y, 7, 3, mode='interp') and deriv=1
const FILT = [0.6095238095238045, 0.21904761904762027, 1.004761904761909, 2.400000000000002, 3.3190476190476215, 4.652380952380955, 5.690476190476193, 6.27619047619048, 6.109523809523813, 5.952380952380954, 4.9095238095238125, 3.919047619047621, 3.561904761904764, 2.961904761904763, 1.9047619047619055, 1.6238095238095247, 1.0952380952380958, 0.7452380952380953, 0.6309523809523823, 0.8357142857142892];
const FILT_D1 = [-1.1674603174603093, 0.2920634920634966, 1.1849206349206365, 1.5111111111111115, 1.233333333333334, 0.7619047619047623, 0.9273809523809532, 0.6873015873015883, -0.3615079365079362, -1.0678571428571426, -0.7730158730158727, -0.6468253968253963, -0.47857142857142837, -0.8091269841269842, -0.7218253968253967, -0.4837301587301588, -0.44007936507936507, -0.24603174603174516, 0.0313492063492079, 0.39206349206349456];

test('coefficients equal scipy savgol_coeffs', () => {
  for (const [k, ref] of Object.entries(SCIPY)) {
    const [w, o, d] = k.split(',').map(Number);
    assertArrayClose(sgCoefficients(w, o, d), ref, 1e-10, k);
  }
});

test('filter output equals scipy savgol_filter(mode="interp"), incl. edges and derivative', () => {
  assertArrayClose(savitzkyGolay(Y, { window: 7, order: 3 }), FILT, 1e-9, 'smooth');
  assertArrayClose(savitzkyGolay(Y, { window: 7, order: 3, deriv: 1 }), FILT_D1, 1e-9, 'deriv 1');
});

test('polynomials of degree ≤ order pass through unchanged everywhere', () => {
  const n = 60, y = Float64Array.from({ length: n }, (_, i) => 2 - 0.3 * i + 0.02 * i * i - 0.0004 * i ** 3);
  assertArrayClose(savitzkyGolay(y, { window: 11, order: 3 }), y, 1e-8);
});

test('bad windows are corrected, invalid coefficient requests rejected', () => {
  const y = Float64Array.from({ length: 9 }, (_, i) => i * i);
  assert(savitzkyGolay(y, { window: 25, order: 3 }).every(Number.isFinite), 'window larger than data shrinks');
  assert(savitzkyGolay(y, { window: 6, order: 2 }).every(Number.isFinite), 'even window bumped to odd');
  assertArrayClose(savitzkyGolay([1, 2], { window: 5, order: 2 }), [1, 2], 0, 'too short: unchanged');
  assertThrows(() => sgCoefficients(6, 2), /odd/);
  assertThrows(() => sgCoefficients(5, 5), /less than/);
});
