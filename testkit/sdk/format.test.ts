import {expect,it} from "vitest";
import {loadMethod} from "../../packages/sdk/src/index.js";
import {method} from "../fixtures/method.js";
it.each(["method/2","method/3","workflow/2"])("rejects unsupported format %s",format=>{expect(()=>loadMethod({...method(),format})).toThrow("UNSUPPORTED_FORMAT");});
