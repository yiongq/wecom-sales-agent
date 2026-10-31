import fs from 'node:fs';
import path from 'node:path';

/** 复用已带许可的字体，不改后台子集；长尾确保新官网汉字也由思源黑体显示。 */
export function copyFonts(destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  const css = fs.readFileSync('console/src/fonts/fonts.css', 'utf8').replace(/url\(([^)]+)\)/g, (_, raw: string) => {
    const file = raw.startsWith('@fontsource') ? path.join('console/node_modules', raw) : path.join('console/src/fonts', raw);
    const name = path.basename(raw);
    fs.copyFileSync(file, path.join(destination, name));
    return `url(./${name})`;
  });
  fs.writeFileSync(path.join(destination, 'fonts.css'), css);
  fs.cpSync('console/public/licenses', path.join(destination, 'licenses'), { recursive: true });
}
