from pathlib import Path
root=Path(__file__).resolve().parents[1]
project=Path(__file__).resolve().parents[3]
handler=(root/'lib/study-handler.cjs').read_text()
curriculum=(root/'lib/curriculum.js').read_text().replace('module.exports={VERSION,build,exercise,gradeInfo,units,mathPaths,mathQuestions,rng};','return {VERSION,build,exercise,gradeInfo,units,mathPaths,mathQuestions,rng};')
assert "require('../lib/curriculum')" in handler
(project/'api/study.js').write_text(handler.replace("require('../lib/curriculum')",'(()=>{\n'+curriculum+'\n})()'))
print('Built server-only study bundle; curriculum source is not a public asset.')
