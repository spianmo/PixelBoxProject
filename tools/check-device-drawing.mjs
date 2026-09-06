import assert from 'node:assert/strict';
import { DevdClient } from '../sdk/dist/devd.js';

const client = await DevdClient.connect(process.argv[2] || '192.168.31.100');
try {
    const result = JSON.parse(await client.evalJs(`JSON.stringify((()=>{
        const a=px.screen.createCanvas(8,8), b=px.screen.createCanvas(8,8);
        try {
            a.clear(0); b.clear(0);
            const data=new Int32Array([0,0,0,0,0, -2,-2,6,6,0xff0000, 2,2,5,5,0x00ff00, 4,1,3,6,0x0000ff, 0,0,8,8,0xffffff]);
            a.fillRects(data.subarray(5),3);
            b.fillRect(-2,-2,6,6,0xff0000);b.fillRect(2,2,5,5,0x00ff00);b.fillRect(4,1,3,6,0x0000ff);
            for(let y=0;y<8;y++)for(let x=0;x<8;x++)if(a.getPixel(x,y)!==b.getPixel(x,y))throw Error('batch pixel mismatch');
            a.fillRects(new Int32Array([2147483647,0,2147483647,8,0xffffff]));
            if(a.getPixel(7,7)!==0)throw Error('integer overflow clipping');
            let rejected=0;
            for(const fn of [()=>a.fillRects([]),()=>a.fillRects(new Int32Array(4)),()=>a.fillRects(data,-1),()=>a.fillRects(data,6)]){
                try{fn()}catch{rejected++}
            }
            if(rejected!==4)throw Error('invalid batch accepted');
            return {pixelsMatched:64,rejected,subarray:true,clipping:true};
        } finally {a.dispose();b.dispose()}
    })())`,15000));
    assert.equal(result.pixelsMatched, 64);
    console.log(JSON.stringify(result));
} finally { client.close(); }
