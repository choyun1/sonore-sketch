// The pictures a result carries, as the page uses them: the same fields
// whether they come from Pyodide (worker.js, reading a Python dict) or from
// the local server (engine.js, reading JSON). `read(key)` gives a field of
// the picture under its Python name, and `data` is its levels, 8-bit.
//
// No DOM here: the worker imports this file too.

// A spectrogram picture (sonore_sketch.page.spectrogram, mask.pictures):
// rows from 0 Hz up to fMax, columns the STFT's time windows.
export function spectrogramPicture(read, data) {
  return {
    data,
    nFreqs: read("n_freqs"),
    nWindows: read("n_windows"),
    fMax: read("f_max"),
    tStart: read("t_start"),
    tStep: read("t_step"),
  };
}

// A list field: an array from the local server, a Python list (a PyProxy)
// in the worker, copied out and released.
function list(value) {
  if (!value?.toJs) return value;
  try {
    return value.toJs();
  } finally {
    value.destroy();
  }
}

// The Scatter events tab's modulation spectrogram (sonore_sketch.events.modulation):
// `frames`, the band x rate depth at each time window (window by window, band
// by band, rate by rate), or `pooled`, rate by time window (rate by rate),
// 8-bit levels over the top rangeDb dB, 0 where a cell is not valid.
export function modulationSpectrogramPicture(read, data) {
  return {
    data,
    nBands: read("n_bands") ?? 0,
    bands: list(read("bands")) ?? [],
    nRates: read("n_rates"),
    rates: list(read("rates")),
    nWindows: read("n_windows"),
    tStart: read("t_start"),
    tStep: read("t_step"),
    rangeDb: read("range_db"),
    topDb: read("top_db"),
  };
}

// A modulation spectrum on the plane: the Draw modulation tab's measured one
// (sonore_sketch.blobs.measured_picture), the Erase modulation tab's source
// (sonore_sketch.edit.plane_picture).
export function modulationPicture(read, data) {
  return {
    data,
    nDensities: read("n_densities"),
    nRates: read("n_rates"),
    rateFirst: read("rate_first"),
    rateStep: read("rate_step"),
    densityStep: read("density_step"),
  };
}
