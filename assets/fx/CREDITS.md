# Effect imagery

Real photos, footage and NASA renders used for Orbit's light, fire, craft and frame. Each file has a full-size
version (desktop) and a `-sm` version (phones and the low tier). All were re-encoded without metadata
(JPEG via Pillow, WebP with no EXIF/XMP). Licences were checked on each file's Wikimedia Commons page
(`extmetadata` LicenseShortName) or on ambientCG, on 2026-10-04.

| File | Source | Author | Licence | What was changed |
| --- | --- | --- | --- | --- |
| explosion.jpg, explosion-sm.jpg | [File:Antares Rocket Explosion (Animated).gif](https://commons.wikimedia.org/wiki/File:Antares_Rocket_Explosion_(Animated).gif) | NASA Television | Public domain (NASA) | Frames 26–61 (the mid-air fireball against the night sky) cropped to a 260 px square around the fireball, the rocket body painted out, the sky glow crushed to black, a round vignette applied; the NASA TV bug and the ground are outside the crop. Packed as a 6×6 flipbook (256 px frames, 128 px for `-sm`). |
| flare.jpg, flare-sm.jpg | [File:The Dog Star, Sirius, and its Tiny Companion (2005-36-1820).jpg](https://commons.wikimedia.org/wiki/File:The_Dog_Star,_Sirius,_and_its_Tiny_Companion_(2005-36-1820).jpg) | NASA, H.E. Bond and E. Nelan (STScI) | Public domain (NASA) | Square crop around Sirius A (caption panel excluded), blacks lifted to zero, radial fade to black. 512 / 256 px. |
| glint.jpg, glint-sm.jpg | [File:JWST Telescope alignment evaluation image labeled.jpg](https://commons.wikimedia.org/wiki/File:JWST_Telescope_alignment_evaluation_image_labeled.jpg) | NASA/STScI | Public domain (NASA) | Square crop around the focused star (the label text is outside the crop), faint background galaxies crushed to black, colour pulled toward warm white, radial fade. 512 / 256 px. |
| streak.jpg, streak-sm.jpg | [File:Lake Point Tower Flare (Anamorphic) (14929131291).jpg](https://commons.wikimedia.org/wiki/File:Lake_Point_Tower_Flare_(Anamorphic)_(14929131291).jpg) | Chad Kainz | CC BY 2.0 | The blue anamorphic streak only: a 120 px strip along the flare, background (the dark building) subtracted, mirrored about the light source, tapered at the ends. 1024×72 / 512×36 px. |
| laser.jpg, laser-sm.jpg | [File:International Observe the Moon Night (5002814445).jpg](https://commons.wikimedia.org/wiki/File:International_Observe_the_Moon_Night_(5002814445).jpg) | NASA Goddard Space Flight Center | Public domain (NASA) | The green laser-ranging beam (right-hand beam) sampled across its width along 1,550 px of its length, sky subtracted, re-centred; stored as the measured cross-section times the measured brightness along the beam, in greyscale (tinted in the shader). 512×32 / 256×16 px. |
| craft.webp, craft-sm.webp | [File:MarCO spacecraft model.png](https://commons.wikimedia.org/wiki/File:MarCO_spacecraft_model.png), [File:Parker Solar Probe spacecraft model.png](https://commons.wikimedia.org/wiki/File:Parker_Solar_Probe_spacecraft_model.png), [File:Transiting Exoplanet Survey Satellite artist concept (transparent background).png](https://commons.wikimedia.org/wiki/File:Transiting_Exoplanet_Survey_Satellite_artist_concept_(transparent_background).png), [File:New Horizons spacecraft model 2.png](https://commons.wikimedia.org/wiki/File:New_Horizons_spacecraft_model_2.png), [File:Juno spacecraft model 2.png](https://commons.wikimedia.org/wiki/File:Juno_spacecraft_model_2.png) | NASA (NASA/JPL-Caltech renders) | Public domain (NASA) | Trimmed to their alpha, scaled to fit 256 px cells (128 px for `-sm`) and packed in a 4×2 atlas in this order: drone = MarCO, fighter = Parker Solar Probe, pod = TESS, hostile = New Horizons, run craft ("UFO") = Juno. No logos or patches are visible at these sizes. Graded and shaded in the shader. |
| steel.jpg, steel-sm.jpg | [ambientCG Metal011](https://ambientcg.com/view?id=Metal011) (Color map, 1K) | ambientCG (Lennart Demes) | CC0 1.0 | Converted to greyscale, contrast normalised (soft tanh curve around mid-grey) so it can be blended over the frame's dark body without changing its tone. Tileable. 512 / 256 px. |

Usage: `realfx.js` (explosions, glints, beams, craft), `planetfx.js` (impacts, beacon, clear sky, supply, attack),
`scene.js` (question streak, ship fire, UFO beam), `frame.js` (steel), `intro.js` (flare, glint, streak in the white-out).

CC BY 2.0 attribution for the streak: "Lake Point Tower Flare (Anamorphic)" by Chad Kainz (from Monterey, CA, USA),
via Wikimedia Commons (link above), licensed CC BY 2.0
(https://creativecommons.org/licenses/by/2.0/); cropped, background-subtracted and mirrored.
