import fs from 'fs';
const content = fs.readFileSync('/data00/home/heyuheng.kevinmatt/workspace/JunimoServer-Web/src/client/components/MapView.tsx', 'utf-8');
const matches = content.match(/img\.src = \`\/assets\/\$\{src\}\`/g);
console.log(matches);
