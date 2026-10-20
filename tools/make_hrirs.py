"""Make the HRIR file the Draw path tab reads (docs/design/tabs/draw_path.md, W2).

The tab uses the MIT KEMAR measurements (Gardner & Martin, 1995), normal
pinna, which MIT provides "without any usage restrictions", asking only that
the authors be cited. This script reads their SOFA file and writes the IRs
and directions as float32 arrays in a compressed ``.npz``, so the browser
needs no ``h5py``. The IRs are kept as measured; the tab's loader puts back
the travel time the files leave out (W4).

The SOFA file is at https://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa
(Debian and Ubuntu also ship it in libmysofa's data package, as
/usr/share/libmysofa/MIT_KEMAR_normal_pinna.sofa).

    python tools/make_hrirs.py path/to/mit_kemar_normal_pinna.sofa
"""

import sys
from pathlib import Path

import numpy as np
import sonore as so

OUT = Path(__file__).resolve().parents[1] / "src" / "sonore_sketch" / "data" / "mit_kemar.npz"


def main(sofa_path: str) -> None:
    hrirs = so.HRIRSet.from_sofa(sofa_path)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        OUT,
        irs=hrirs.irs.astype(np.float32),
        positions=hrirs.positions.astype(np.float32),
        fs=np.array(hrirs.fs),
    )
    print(f"{hrirs} -> {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/usr/share/libmysofa/MIT_KEMAR_normal_pinna.sofa")
