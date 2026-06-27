import fs from 'fs';
import path from 'path';

function listFiles(dir: string, extensions: string[]): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'build', '.git', '.gemini', 'storage'].includes(file)) continue;
      results = results.concat(listFiles(filePath, extensions));
    } else {
      if (extensions.some(ext => file.endsWith(ext))) {
        results.push(filePath);
      }
    }
  }
  return results;
}

function restoreAuth() {
  const tsFiles = listFiles(path.join(__dirname, '../src'), ['.ts']);
  let modifiedCount = 0;

  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf8');
    let updated = content;

    // Replace basic auth username literals
    updated = updated.replace(/username:\s*'Cynex'/g, "username: 'Airlink'");
    updated = updated.replace(/username:\s*"Cynex"/g, 'username: "Airlink"');
    updated = updated.replace(/username\s*!==\s*'Cynex'/g, "username !== 'Airlink'");
    updated = updated.replace(/username\s*!==\s*"Cynex"/g, 'username !== "Airlink"');
    updated = updated.replace(/username\s*===\s*'Cynex'/g, "username === 'Airlink'");
    updated = updated.replace(/username\s*===\s*"Cynex"/g, 'username === "Airlink"');

    if (content !== updated) {
      fs.writeFileSync(file, updated, 'utf8');
      console.log(`[Restored Auth] ${path.relative(path.join(__dirname, '..'), file)}`);
      modifiedCount++;
    }
  }

  console.log(`\nSuccessfully restored daemon authentication protocol in ${modifiedCount} files.`);
}

restoreAuth();
