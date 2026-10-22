import embed from "vega-embed";
import { expressionInterpreter } from "vega-interpreter";
const spec = { $schema:"https://vega.github.io/schema/vega-lite/v5.json",
 data:{values:[{a:"A",b:3},{a:"B",b:7},{a:"C",b:5}]},
 mark:"bar", encoding:{x:{field:"a",type:"nominal"},y:{field:"b",type:"quantitative"}}};
(async()=>{try {
  const r = await embed("#chart", spec, { ast:true, expr:expressionInterpreter, renderer:"svg" });
  const svg = await r.view.toSVG();
  document.getElementById("out").textContent = "SVG_OK " + svg.length;
  console.log("SVG_OK", svg.length);
} catch(e){ console.log("SVG_FAIL", e.message); }
})();
