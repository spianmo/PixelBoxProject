import React from 'react'
import { createRoot } from 'react-dom/client'
import { SimPanel } from '../../src/renderer/src/device-sim/panel/SimPanel'
import { ensureSession, setSessionViewMode } from '../../src/renderer/src/device-sim/sessions'
import { HardwareViewer } from '../../src/renderer/src/hardware/three/HardwareViewer'
import { DEFAULT_ENCLOSURE } from '../../src/shared/hardwareDefaults'
import '../../src/renderer/src/i18n'

// 只替代 Electron 文件/网络桥;引擎、沙箱 iframe、px API 与 React/Three 交互均使用真实实现。
window.api = {
  sim: {
    readTree: async () => [], storageLoad: async () => ({ files: [], kvJson: '{}' }),
    onNetEvent: () => () => undefined
  }
} as unknown as typeof window.api
window.__pixelboxSimContext = { workspaceRoot: '/imu-check', outDir: '/imu-check/dist' }

const viewers: HardwareViewer[] = []
const setHardware = HardwareViewer.prototype.setHardware
HardwareViewer.prototype.setHardware = function (hardware) {
  if (!viewers.includes(this)) viewers.push(this)
  setHardware.call(this, hardware)
}

const session = ensureSession({
  id: 'imu-browser', name: 'IMU 检查设备', chip: 'esp32s3', screenW: 480, screenH: 480,
  psramMB: 8, flashMB: 16,
  hardware3d: {
    board: { widthMM: 54, heightMM: 54, thicknessMM: 1.6, components: [] },
    screen: { x: 0, y: 0, w: 42, h: 42 },
    enclosure: { ...DEFAULT_ENCLOSURE, colorHex: '#dddddd' }
  }
})
const samples: unknown[] = []
const orientations: string[] = []
const touches: unknown[] = []
window.addEventListener('pixelbox-sim:log', (event) => {
  const text = event.detail.text
  if (text.startsWith('IMU ')) samples.push(JSON.parse(text.slice(4)))
  if (text.startsWith('ORIENT ')) orientations.push(text.slice(7))
  if (text.startsWith('TOUCH ')) touches.push(JSON.parse(text.slice(6)))
})
const root = createRoot(document.getElementById('root')!)
root.render(<SimPanel engine={session.engine} screen={{ width: 480, height: 480 }} />)
Object.assign(window, { imuCheck: {
  engine: session.engine, viewers, samples, orientations, touches,
  switchView: (mode: '2d' | '3d') => setSessionViewMode(session.key, mode)
} })

void session.engine.api.load(`
  var accel = { ax: 0, ay: 0 };
  px.sensors.imu.start({ rateHz: 50, onData: function(d) {
    console.log('IMU ' + JSON.stringify(d));
    accel = d;
  }});
  px.screen.onFrame(function() {
    px.screen.clear(0x142728);
    px.screen.fillRect(210 - accel.ax * 100, 210 - accel.ay * 100, 60, 60, 0x53e6ae);
  });
  px.sensors.imu.onOrientation(function(o) { console.log('ORIENT ' + o); });
  px.input.onTouch(function(e) { console.log('TOUCH ' + JSON.stringify(e)); });
`, { id: 'imu-check', name: 'IMU Check', version: '1.0.0', entry: 'main.js' })
