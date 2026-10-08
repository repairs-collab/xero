# Third-party notices for the AccountPulse voice gateway

## Piper 1.8.0

- Project: [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl/tree/v1.8.0)
- Package: `piper-tts==1.8.0`
- Licence: GNU General Public License v3.0 or later
- Use: Piper runs as a separate local process to render deterministic speech. AccountPulse does not modify Piper and does not send text or audio to a third-party speech service.

The installed Python package retains its licence files inside the runtime environment. Source for the exact upstream release is available at the project link above.

## Alba medium English voice model

- Project: [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/217ddc79818708b078d0d14a8fae9608b9d77141/en/en_GB/alba/medium)
- Model: `en_GB-alba-medium`
- Dataset/model-card licence: Creative Commons Attribution 4.0 International
- Source corpus: University of Edinburgh Alba speech corpus, as identified by the upstream model card
- Upstream commit: `217ddc79818708b078d0d14a8fae9608b9d77141`

The model and configuration are fetched from that immutable revision during the container build and verified using the SHA-256 values recorded in the Dockerfile. The upstream `MODEL_CARD` is retained in the image. No Australian-English model is currently published in the upstream Piper voice collection, so this British-English voice is the initial controlled test voice and must pass the staff-only clarity test before customer use.

## FFmpeg

- Project: [FFmpeg](https://ffmpeg.org/)
- Distribution: Debian Bookworm package
- Use: converts locally generated mono WAV audio to 8 kHz, 16-bit PCM for Asterisk

The applicable FFmpeg component licences and source availability are provided by Debian in accordance with the package build included in the container.
