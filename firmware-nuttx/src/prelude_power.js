/* GPIO 保留完整原按钮语义，PWR 只转发 PMU 实际提供的短按/长按事件。 */
const buttonSubscribers = new Set();
let buttonTimer = 0;
px.input.onButton = callback => {
  if (typeof callback !== 'function') throw new TypeError('onButton needs a function');
  if (!native.buttonsAvailable()) unsupported();
  if (!buttonSubscribers.size) native.buttonsListen(true);
  buttonSubscribers.add(callback);
  if (!buttonTimer) buttonTimer = setInterval(() => {
    for (const event of native.buttonsPoll())
      for (const subscriber of [...buttonSubscribers]) subscriber(event);
  }, 5);
  return () => {
    buttonSubscribers.delete(callback);
    if (!buttonSubscribers.size) {
      if (buttonTimer) { clearInterval(buttonTimer); buttonTimer = 0; }
      native.buttonsListen(false);
    }
  };
};
exitHandlers.add(() => {
  if (buttonTimer) clearInterval(buttonTimer);
  buttonTimer = 0; buttonSubscribers.clear();
  native.buttonsListen(false);
});
