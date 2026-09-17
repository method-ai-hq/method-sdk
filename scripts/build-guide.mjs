import {writeFileSync} from 'node:fs';
import {authoringGuide} from '../packages/sdk/dist/packages/sdk/src/method-help.js';
writeFileSync(new URL('../docs/method-authoring.md',import.meta.url),'<!-- Generated from packages/sdk/src/method-help.ts. -->\n\n'+authoringGuide('all'));
