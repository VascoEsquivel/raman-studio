/* Laser-energy dispersion of Raman bands.

   Double-resonance bands (D, 2D …) move with the excitation energy, so a library
   written for one laser has to be shifted before it can label a spectrum taken
   with another. The rate is per eV of photon energy, which is why everything
   here is converted from wavelength to energy first. */

// hc in eV·nm (CODATA 2018: h·c / e = 1239.841984… eV·nm). Kept at the precision
// the contract quotes so the shift numbers in tests and in the UI agree exactly.
const HC_EV_NM = 1239.841984;

/**
 * Photon energy of a laser line.
 * @param {number} nm wavelength in nanometres
 * @returns {number} energy in eV (NaN for a missing or non-positive wavelength)
 */
export function photonEnergyEV(nm) {
  const v = Number(nm);
  // NaN rather than Infinity/negative energies: callers treat NaN as "unknown laser".
  if (!Number.isFinite(v) || v <= 0) return NaN;
  return HC_EV_NM / v;
}

/**
 * Band shift for a laser relative to the reference excitation the library assumes.
 * @param {number|null} cmPerEV dispersion rate, cm⁻¹ per eV (null = unknown)
 * @param {number} laserNm excitation used for the measurement
 * @param {number} refNm excitation the library positions refer to
 * @returns {number} cm⁻¹ to add to the library position (0 when any input is unknown)
 */
export function dispersionShift(cmPerEV, laserNm, refNm) {
  const rate = cmPerEV == null ? NaN : Number(cmPerEV);
  const dE = photonEnergyEV(laserNm) - photonEnergyEV(refNm);
  // An unknown rate or laser must not move a band: those bands are handled by
  // widening their window instead (see prepareLibrary), never by guessing a rate.
  if (!Number.isFinite(rate) || !Number.isFinite(dE)) return 0;
  return rate * dE;
}
