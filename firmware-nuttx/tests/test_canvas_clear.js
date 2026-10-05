const clearCheck = (value, message) => { if (!value) throw new Error(message); };
const clearEqual = (a, b, message) => clearCheck(JSON.stringify(a) === JSON.stringify(b), message);

/* 原生清屏必须只记录实际变色的像素，并把已有 tracker 脏区带回 JS。 */
{
  const canvas = new Canvas(8, 4);
  canvas._changedRows = new Uint16Array(canvas.height * 2);
  canvas._dirtyBlocks = new Uint32Array(canvas.height);
  canvas._pixels.fill(0x112233);
  canvas._dirty = null;
  canvas.clear(0x445566);
  clearCheck(canvas._pixels.every(pixel => pixel === 0x445566), 'clear writes every pixel');
  clearEqual(canvas._dirty, {x: 0, y: 0, right: 8, bottom: 4}, 'clear dirty bounds');
  clearCheck(canvas._changedRows.every((value, index) => value === (index % 2 ? 8 : 1)),
    'clear row tracker');
  clearCheck(canvas._dirtyBlocks.every(value => value === 1), 'clear block tracker');
}

/* 同色清屏不得制造新的 framebuffer 提交。 */
{
  const canvas = new Canvas(9, 3);
  canvas._changedRows = new Uint16Array(canvas.height * 2);
  canvas._dirtyBlocks = new Uint32Array(canvas.height);
  canvas._pixels.fill(0x123456);
  canvas._dirty = null;
  canvas.clear(0x123456);
  clearCheck(canvas._dirty === null, 'same-color clear stays clean');
  clearCheck(canvas._changedRows.every(value => value === 0), 'same-color rows stay clean');
  clearCheck(canvas._dirtyBlocks.every(value => value === 0), 'same-color blocks stay clean');
}

/* 清屏结果必须合并调用前已有的行范围，不能让旧脏区丢失。 */
{
  const canvas = new Canvas(10, 3);
  canvas._changedRows = new Uint16Array([3, 5, 0, 0, 0, 0]);
  canvas._dirtyBlocks = new Uint32Array(3);
  canvas._pixels.fill(0);
  canvas._pixels.fill(7, 0, 10);
  canvas._dirty = {x: 2, y: 0, right: 5, bottom: 1};
  canvas.clear(7);
  clearEqual(canvas._dirty, {x: 0, y: 0, right: 10, bottom: 3}, 'clear preserves old dirty union: ' + JSON.stringify(canvas._dirty));
  clearCheck(canvas._changedRows[0] === 3 && canvas._changedRows[1] === 5,
    'clear preserves old row tracker');
  clearCheck(canvas._changedRows[2] === 1 && canvas._changedRows[3] === 10 &&
    canvas._changedRows[4] === 1 && canvas._changedRows[5] === 10,
    'clear tracks changed rows');
}

/* 参数、别名和中断路径必须在写入前或失败后给出明确契约。 */
{
  const pixels = new Uint32Array(4), rows = new Uint16Array(4), blocks = new Uint32Array(2);
  throws(() => native.clearCanvas(pixels, 0, 2, 1, rows, blocks), RangeError, 'clear dimensions');
  throws(() => native.clearCanvas(pixels, 2, 2, 1, new Uint16Array(2), blocks), RangeError, 'clear row size');
  throws(() => native.clearCanvas(pixels, 2, 2, 1, rows, new Uint32Array(1)), RangeError, 'clear block size');
  throws(() => native.clearCanvas(pixels, 2, 2, 1, new Uint16Array(pixels.buffer), blocks), RangeError, 'clear row alias');
  const directPixels = new Uint32Array(128 * 128);
  const directRows = new Uint16Array(128 * 2);
  const directBlocks = new Uint32Array(128);
  armInterrupt(0);
  let directInterrupted = false;
  try { native.clearCanvas(directPixels, 128, 128, 0, directRows, directBlocks); }
  catch (error) { directInterrupted = error instanceof InternalError; }
  clearCheck(directInterrupted,
    'direct clear interruption polls=' + interruptPollCount());
  const interrupted = new Canvas(128, 128);
  interrupted._changedRows = new Uint16Array(interrupted.height * 2);
  interrupted._dirtyBlocks = new Uint32Array(interrupted.height);
  interrupted._pixels.fill(9);
  armInterrupt(0);
  throws(() => interrupted.clear(0), InternalError, 'clear interruption');
  armInterrupt(-1);
  clearCheck(interrupted._changedRows.every((value, index) => value === (index % 2 ? 128 : 1)),
    'clear interruption invalidates rows');
  const validBlockBits = (1 << Math.ceil(128 / 8)) - 1;
  clearCheck(interrupted._dirtyBlocks.every(value => value === validBlockBits),
    'clear interruption invalidates blocks');
}
