/**
 * __PROJECT_NAME__ — ESP32-S3-Touch-AMOLED-2.16 官方资料重建。
 * 213 个元件 / 642 个引脚 / 181 个网络来自官方 PDF 书签。
 * PCB 轮廓与元件中心来自放大打印页，焊盘仅是可编辑定位标记，绝非制造封装。
 * 完成封装、层叠、布线和实物装配验证后才能制板；禁止用本模板直接生产。
 * design/official-data.ts 是本工程可编辑数据；official-netlist.json 是只读对照基准。
 */
import data from './official-data'

const pinNets: Record<string, string> = {}
data.nets.forEach((net, i) => net.pins.forEach((pin) => { pinNets[pin] = `net.N${i}` }))

export default () => (
  <board outline={data.outline.map(([x, y]) => ({ x, y }))} thickness="1.6mm" routingDisabled schTraceAutoLabelEnabled>
    {data.nets.map((net, i) => <net name={`N${i}`} />)}
    {data.components.map((c, ci) => {
      const x = c.pcb?.x ?? 0
      const y = c.pcb?.y ?? 0
      const labels = Object.fromEntries(c.pins.map((pin, i) => [`pin${i + 1}`, [pin.split("/")[0]]]))
      return (
        <chip name={c.name} manufacturerPartNumber={c.value || undefined}
          pcbX={x} pcbY={y} layer="bottom" pinLabels={labels}
          schX={(ci % 12) * 7} schY={-Math.floor(ci / 12) * 12}
          schWidth={4} schHeight={Math.max(2, c.pins.length * 0.18)}
          footprint={
            <footprint>
              {/* PDF 引脚点击框属于原理图坐标，不能拿来计算 PCB 封装。此参考图仅用居中小标记。 */}
              {c.pins.map((_, i) => <smtpad portHints={[`pin${i + 1}`]}
                pcbX={((i % 8) - (Math.min(c.pins.length, 8) - 1) / 2) * 0.3}
                pcbY={(Math.floor(i / 8) - (Math.ceil(c.pins.length / 8) - 1) / 2) * 0.3}
                shape="rect" width="0.15mm" height="0.15mm" />)}
              <silkscreentext text={`${c.name} ?`} pcbX={0} pcbY={0} fontSize="0.5mm" />
            </footprint>
          }
        />
      )
    })}
    {/* 显式网络标签避免将数百个引脚交给全图原理图寻路；PCB 连通关系仍完整。 */}
    {data.components.flatMap((c) => c.pins.map((pin, i) => <trace
      from={`.${c.name} > .pin${i + 1}`} to={pinNets[`${c.name}-${pin}`]}
      schDisplayLabel={data.nets.find((net) => net.pins.includes(`${c.name}-${pin}`))?.name} />))}
  </board>
)
