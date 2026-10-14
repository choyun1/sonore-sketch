# Data the tabs read

`mit_kemar.npz`: head-related impulse responses of a KEMAR mannequin with the
normal pinna, 710 directions at 1.4 m, elevations −40° to 90°, 44.1 kHz, as
float32 arrays (`irs`, shape 710 × 2 × 512; `positions`, Cartesian meters
as sonore uses them; `fs`). Made by `tools/make_hrirs.py` from the SOFA copy
of the measurements. The Draw path tab reads it
(`docs/design/tabs/paths.md`).

The measurements are by Bill Gardner and Keith Martin at the MIT Media Lab.
Their documentation says: "This HRTF data is Copyright 1994 by the MIT Media
Lab. It is provided without any usage restrictions. We request that you cite
the authors when using this data for research or commercial applications."
(https://sound.media.mit.edu/resources/KEMAR/hrtfdoc.txt)

Gardner, W. G., & Martin, K. D. (1995). HRTF measurements of a KEMAR. *The
Journal of the Acoustical Society of America*, 97(6), 3907–3908.
