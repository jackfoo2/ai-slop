// Put the AI Slop Overlay icon and name into the Windows program file (no Windows needed).
import { readFileSync, writeFileSync } from 'node:fs';
import * as ResEdit from 'resedit';
import * as PELibrary from 'pe-library';
const exePath = 'winpkg/AI Slop Overlay/AI Slop Overlay.exe';
const exe = PELibrary.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const icon = ResEdit.Data.IconFile.from(readFileSync('app/assets/icon.ico'));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, icon.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
const lang = vi.getAllLanguagesForStringValues()[0];
vi.setStringValues(lang, { FileDescription: 'AI Slop Overlay', ProductName: 'AI Slop Overlay', InternalName: 'AI Slop Overlay', OriginalFilename: 'AI Slop Overlay.exe', CompanyName: '', LegalCopyright: '' });
vi.setFileVersion(0, 6, 0, 0, lang.lang); vi.setProductVersion(0, 6, 0, 0, lang.lang);
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
writeFileSync(exePath, Buffer.from(exe.generate()));
// read it back to make sure
const check = PELibrary.NtExecutableResource.from(PELibrary.NtExecutable.from(readFileSync(exePath), { ignoreCert: true }));
const g2 = ResEdit.Resource.IconGroupEntry.fromEntries(check.entries)[0];
const v2 = ResEdit.Resource.VersionInfo.fromEntries(check.entries)[0];
console.log('icon sizes in the program:', g2.icons.map((i) => `${i.width || 256}px`).join(', '));
console.log('program name:', v2.getStringValues(v2.getAllLanguagesForStringValues()[0]).FileDescription, '| version', v2.getStringValues(v2.getAllLanguagesForStringValues()[0]).ProductVersion || '0.3.0');
