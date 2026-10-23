#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models/diffusion_models models/text_encoders models/vae models/loras
fetch() {
  local url="$1" out="$2"
  if [[ -s "$out" ]]; then echo "Skip existing: $out"; return; fi
  echo "Downloading $(basename "$out") ..."
  curl --fail --location --retry 4 --retry-delay 3 --continue-at - "$url" -o "$out"
}
BASE="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files"
fetch "$BASE/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors" "models/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors"
fetch "$BASE/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors" "models/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors"
fetch "$BASE/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors" "models/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors"
fetch "$BASE/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors" "models/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors"
fetch "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" "models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
fetch "$BASE/vae/wan_2.1_vae.safetensors" "models/vae/wan_2.1_vae.safetensors"
echo "Model downloads complete. This downloads tens of GB; ensure enough disk and GPU memory."
