# Собирает public/index.html из index.src.html и общего стиля style.css
import pathlib
root = pathlib.Path(__file__).parent
src = (root/'index.src.html').read_text()
css = (root/'style.css').read_text()
(root/'public/index.html').write_text(src.replace('/*CSS*/', css))
print('built', len(src)+len(css))
