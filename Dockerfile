# Easypanel: nic se tu nepřekládá (Rust build tam padal na paměti).
# Hotový image staví GitHub Actions z Dockerfile.build a posílá do GHCR; tady se jen stáhne.
# Tag je připnutý na konkrétní verzi (sha-<commit>): Easypanel jinak vezme z cache starý `latest`.
# Při vydání nové verze tag přepiš na `sha-<krátký hash>` commitu, jehož image už je v GHCR.
# Vlastní build lokálně: docker build -f Dockerfile.build -t mluvka .
FROM ghcr.io/pawlig/mluvka:sha-d014e47
