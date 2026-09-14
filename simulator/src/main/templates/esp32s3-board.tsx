/** __PROJECT_NAME__：ESP32-S3 主控扩展板。5V 输入、3.3V UART、QSPI 屏转接板及 I2C 外设。 */
import { ESP32S3 } from './esp32-s3-wroom'
import routes from './routes'


const Header = ({name, x, y, signals, schX, schY, horizontal=false}: {name:string; x:number; y:number; signals:string[]; schX:number; schY:number; horizontal?:boolean}) => (
  <chip name={name} pcbX={x} pcbY={y} schX={schX} schY={schY}
    schWidth={3} schHeight={signals.length*.35+1}
    manufacturerPartNumber={`PinHeader_1x${signals.length}_P1.27mm`}
    pinLabels={Object.fromEntries(signals.map((s,i)=>[`pin${i+1}`,[s]]))}
    footprint={<footprint>
      <silkscreentext text={name} pcbX={0} pcbY={horizontal?2:(signals.length-1)*.635+1.4} fontSize={1}/>
      {signals.map((_,i)=><silkscreentext text={String(i+1)} pcbX={horizontal?(i-(signals.length-1)/2)*1.27:-1.5} pcbY={horizontal?-1.5:((signals.length-1)/2-i)*1.27} fontSize={.7}/>)}
      {signals.map((s,i)=><platedhole portHints={[`pin${i+1}`]} pcbX={horizontal?(i-(signals.length-1)/2)*1.27:0} pcbY={horizontal?0:((signals.length-1)/2-i)*1.27} holeDiameter={.65} outerDiameter={1} shape="circle" />)}
    </footprint>} />
)
export default () => <board width={41} height={41} borderRadius={3.3} thickness={1.6} schTraceAutoLabelEnabled
  autorouterVersion="v6" autorouter={{local:true,groupMode:'subcircuit',traceClearance:.2}} defaultTraceWidth={.25} pcbStyle={{viaHoleDiameter:.3,viaPadDiameter:.6}}
  minTraceWidth={.2} minViaHoleDiameter={.3} minViaPadDiameter={.6} minBoardEdgeClearance={.5} minTraceToPadEdgeClearance={.15} minViaEdgeToPadEdgeClearance={.15} minPadEdgeToPadEdgeClearance={.15}>

  <ESP32S3 name="U1" pcbX={0} pcbY={0} schX={0} schY={0} schWidth={6} schHeight={15}/>
  <chip name="U2" manufacturerPartNumber="AP2112K-3.3TRG1" pcbX={-12.6} pcbY={2.5} schX={-12} schY={10}
    pinLabels={{pin1:['VIN'],pin2:['GND'],pin3:['EN'],pin4:['NC'],pin5:['VOUT']}}
    footprint={<footprint>{[[-.95,-1.1],[0,-1.1],[.95,-1.1],[.95,1.1],[-.95,1.1]].map(([x,y],i)=><smtpad portHints={[`pin${i+1}`]} shape="rect" pcbX={x} pcbY={y} width={.6} height={1.2}/>)}</footprint>}/>
  <capacitor name="C1" capacitance="10uF" footprint="0805" pcbX={-13} pcbY={6} schX={-16} schY={10}/>
  <capacitor name="C2" capacitance="10uF" footprint="0805" pcbX={-13} pcbY={11.3} schX={-8} schY={10}/>
  <capacitor name="C3" capacitance="100nF" footprint="0603" pcbX={-12.4} pcbY={8} schX={-8} schY={7}/>
  <capacitor name="C4" capacitance="1uF" footprint="0603" pcbX={-12.5} pcbY={-1} schX={-8} schY={4}/>
  <resistor name="R1" resistance="10k" footprint="0603" pcbX={-12.5} pcbY={-3.8} schX={-12} schY={4}/>
  <resistor name="R2" resistance="10k" footprint="0603" pcbX={12} pcbY={-8} schX={8} schY={7}/>
  <resistor name="R3" resistance="4.7k" footprint="0603" pcbX={-12.5} pcbY={-6.6} schX={-12} schY={-10}/>
  <resistor name="R4" resistance="4.7k" footprint="0603" pcbX={-12.5} pcbY={-9.4} schX={-8} schY={-10}/>
  <Header name="J1" x={13} y={12} signals={['5V','GND','TXD','RXD']} schX={12} schY={10}/>
  <Header name="J2" x={-17} y={7} signals={['5V','GND','D0','D1','D2','D3','CLK','CS','RST']} schX={-16} schY={0}/>
  <Header name="J3" x={-17} y={-7} signals={['GND','3V3','SDA','SCL','INT','RST']} schX={-16} schY={-10}/>
  <Header name="J4" x={-6.5} y={-15} horizontal signals={['GND','16','17','18','8','9','10','13','21']} schX={-6} schY={-18}/>
  <Header name="J5" x={6.5} y={-15} horizontal signals={['GND','42','45','46','47','48','41','1','2']} schX={6} schY={-18}/>
  <Header name="J6" x={17} y={3} signals={['EN','GND']} schX={12} schY={4}/>
  <Header name="J7" x={17} y={-4} signals={['BOOT','GND']} schX={12} schY={0}/>
  {[-17,17].flatMap(x=>[-18.5,18.5].map(y=><hole pcbX={x} pcbY={y} diameter={2.4}/>))}
  {/* 路径相对元件原点；移动元件后必须同步重新布线并通过制造检查。 */}
  {routes.map(r=><trace name={r.id} from={r.fromSelector} to={r.toSelector} thickness={r.width} schDisplayLabel={r.net} pcbPath={r.path}/>)}
</board>
