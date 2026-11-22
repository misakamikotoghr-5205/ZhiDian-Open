## macOS/Linux Lite installers

These packages contain **ZhiDian v0.5.0** without the large Qwen GGUF base-model weights. Deterministic Office/PDF utilities do not require a model; local AI features require downloading verified model and llama.cpp runtime files via **Advanced Settings → Local Model → Download Model**. The existing Windows full-offline release is unchanged.

| Platform | Asset | Install |
|---|---|---|
| Apple Silicon macOS | `Zhidian-v0.5.0-macos-arm64-lite.dmg` | Open DMG and drag `Zhidian.app` to Applications |
| Intel macOS | `Zhidian-v0.5.0-macos-x64-lite.dmg` | Open DMG and drag `Zhidian.app` to Applications |
| Ubuntu/Debian x86-64 | `Zhidian-v0.5.0-linux-x64-lite.deb` | `sudo apt install ./Zhidian-v0.5.0-linux-x64-lite.deb` |
| Ubuntu/Debian ARM64 | `Zhidian-v0.5.0-linux-arm64-lite.deb` | `sudo apt install ./Zhidian-v0.5.0-linux-arm64-lite.deb` |

macOS `.zip` files and Linux `.tar.gz` files are portable alternatives. Separate `SHA256SUMS-macos-*.txt` and `SHA256SUMS-linux-*.txt` files document the checksums, which are verified before upload.

**macOS security:** The app is ad-hoc signed for integrity but is **not Apple Developer ID-signed or notarized**. If blocked by Gatekeeper, after attempting to launch use **System Settings → Privacy & Security → Open Anyway**. Grant Screen Recording, Accessibility, and Automation permissions as needed for desktop context features.

**Feature limits:** Windows Explorer/Desktop icon-rectangle selection via Shell COM is **Windows-only**. macOS supports foreground/Finder selection context with permission, but not equivalent geometric icon binding or arbitrary window control. Linux foreground context uses **X11** and does not support Wayland or icon-region file binding. Use the application's explicit file chooser where native binding is unsupported. Native UI operation still needs end-user testing on the target systems.

Built on native GitHub Actions runners for macOS Intel, macOS Apple Silicon, Linux x64 and Linux arm64; each job runs Node tests and checks the packaged executable architecture. Release files receive SHA-256 verification.
