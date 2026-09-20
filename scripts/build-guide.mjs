import {writeFileSync,mkdirSync} from 'node:fs';
import {authoringGuide} from '../packages/sdk/dist/packages/sdk/src/method-help.js';
writeFileSync(new URL('../docs/method-authoring.md',import.meta.url),'<!-- Generated from packages/sdk/src/method-help.ts. -->\n\n'+authoringGuide('all'));

import {authoringExamples,renderExample} from '../packages/sdk/dist/packages/sdk/src/authoring-example.js';
const directory = new URL('../docs/examples/',import.meta.url);mkdirSync(directory,{recursive:true});
for(const example of authoringExamples)writeFileSync(new URL(example.id+'.md',directory),renderExample(example.id,false));
