# Easypanel: nic se tu nepřekládá (Rust build tam padal na paměti).
# Hotový image staví GitHub Actions z Dockerfile.build a posílá do GHCR; tady se jen stáhne.
# Vlastní build lokálně: docker build -f Dockerfile.build -t mluvka .
FROM ghcr.io/pawlig/mluvka:latest
