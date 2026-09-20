import {expect,it} from 'vitest';
import {workflowDocumentDigest} from '../../packages/contracts/src/identity.js';
import {packageDigest} from '../../packages/contracts/src/method-package.js';
it('preserves classifier option order in saved documents and package identity',()=>{
 const a={format:'method/3.2',steps:{classify:{name:'Classify',in:{message:'inputs.message',subject:'inputs.subject'},do:{kind:'classify',question:'Which team?',options:{billing:'Payments',other:'Other'}},out:'category'}}};
 const b=structuredClone(a);b.steps.classify.do.options={other:'Other',billing:'Payments'};
 expect(workflowDocumentDigest(a)).not.toBe(workflowDocumentDigest(b));
 expect(packageDigest(a,{runtime:'0.9.1',files:[]})).not.toBe(packageDigest(b,{runtime:'0.9.1',files:[]}));
 const equivalent=structuredClone(a);equivalent.steps.classify.in={subject:'inputs.subject',message:'inputs.message'};
 expect(workflowDocumentDigest(a)).toBe(workflowDocumentDigest(equivalent));
});
