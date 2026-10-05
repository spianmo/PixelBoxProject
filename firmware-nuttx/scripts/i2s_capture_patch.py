#!/usr/bin/env python3
"""修复受控 NuttX ESP32-S3 I2S 的 DMA 内存、引用、超时及双工时钟。"""
from pathlib import Path
import argparse

from es8311_patch import function_body, modify_function, replace_exact

MARKER = "/* PixelBox I2S capture and DMA fixes v2. */"
OLD_MARKER = "/* PixelBox I2S capture and DMA fixes v1. */"
HEADER_MARKER = "/* PixelBox capture control: keep TX clocks alive for RX. */"

HELPERS = r'''
/* DMA 描述符必须引用内部 SRAM，不能落到普通 PSRAM malloc 区。 */
#ifdef CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP
#  define pixelbox_dma_calloc(n, s) xtensa_imm_calloc(n, s)
#  define pixelbox_dma_free(p) xtensa_imm_free(p)
#else
#  define pixelbox_dma_calloc(n, s) calloc(n, s)
#  define pixelbox_dma_free(p) free(p)
#endif
'''

CLOCK_AND_TIMEOUT = r'''
/* FIFO 空时继续输出 BCLK/WS，使仅 RX 的 ES7210 采集仍有主时钟。 */
static void pixelbox_capture_clock(struct esp32s3_i2s_s *priv)
{
#if defined(I2S_HAVE_TX) && defined(I2S_HAVE_RX)
  if (priv->config->tx_en && priv->config->rx_en &&
      priv->config->role == I2S_ROLE_MASTER)
    {
      if (priv->capture)
        {
          modifyreg32(I2S_TX_CONF_REG(priv->config->port),
                      I2S_TX_STOP_EN, I2S_TX_START | I2S_TX_UPDATE);
        }
      else
        {
          uint32_t clear = sq_empty(&priv->tx.act) && sq_empty(&priv->tx.pend)
                           ? I2S_TX_START : 0;
          modifyreg32(I2S_TX_CONF_REG(priv->config->port), clear,
                      I2S_TX_STOP_EN | I2S_TX_UPDATE);
        }
    }
#else
  (void)priv;
#endif
}

#ifdef I2S_HAVE_TX
static void pixelbox_tx_timeout(wdparm_t argument)
{
  struct esp32s3_i2s_s *priv = (struct esp32s3_i2s_s *)argument;
  struct esp32s3_buffer_s *buffer;
  irqstate_t flags = spin_lock_irqsave(&priv->slock);
  i2s_tx_channel_stop(priv);
  SET_GDMA_CH_REG(DMA_OUT_INT_CLR_CH0_REG, priv->dma_channel, UINT32_MAX);
  while ((buffer = (struct esp32s3_buffer_s *)sq_remfirst(&priv->tx.act)) != NULL)
    {
      buffer->result = -ETIMEDOUT;
      sq_addlast((sq_entry_t *)buffer, &priv->tx.done);
    }
  while ((buffer = (struct esp32s3_buffer_s *)sq_remfirst(&priv->tx.pend)) != NULL)
    {
      buffer->result = -ETIMEDOUT;
      sq_addlast((sq_entry_t *)buffer, &priv->tx.done);
    }
  i2s_tx_channel_start(priv);
  pixelbox_capture_clock(priv);
  if (work_available(&priv->tx.work))
    work_queue(HPWORK, &priv->tx.work, i2s_tx_worker, priv, 0);
  spin_unlock_irqrestore(&priv->slock, flags);
}
#endif

#ifdef I2S_HAVE_RX
static void pixelbox_rx_abort(struct esp32s3_i2s_s *priv, int error)
{
  struct esp32s3_buffer_s *buffer;
  irqstate_t flags = spin_lock_irqsave(&priv->slock);
  wd_cancel(&priv->rx.watchdog);
  i2s_rx_channel_stop(priv);
  SET_GDMA_CH_REG(DMA_IN_INT_CLR_CH0_REG, priv->dma_channel, UINT32_MAX);
  while ((buffer = (struct esp32s3_buffer_s *)sq_remfirst(&priv->rx.act)) != NULL)
    {
      buffer->result = error;
      sq_addlast((sq_entry_t *)buffer, &priv->rx.done);
    }
  while ((buffer = (struct esp32s3_buffer_s *)sq_remfirst(&priv->rx.pend)) != NULL)
    {
      buffer->result = error;
      sq_addlast((sq_entry_t *)buffer, &priv->rx.done);
    }
  i2s_rx_channel_start(priv);
  if (work_available(&priv->rx.work))
    work_queue(HPWORK, &priv->rx.work, i2s_rx_worker, priv, 0);
  spin_unlock_irqrestore(&priv->slock, flags);
}

static void pixelbox_rx_timeout(wdparm_t argument)
{
  pixelbox_rx_abort((struct esp32s3_i2s_s *)argument, -ETIMEDOUT);
}
#endif

'''


def patch_text(source: str) -> str:
    if MARKER in source:
        return source
    if OLD_MARKER in source:
        raise ValueError('I2S v1 detected: restore pinned esp32s3_i2s.c/h before applying v2')
    source = replace_exact(source, '#include <nuttx/clock.h>', '#include <nuttx/clock.h>\n#include <nuttx/wdog.h>')
    source = replace_exact(source, '#include "xtensa.h"', '#include "xtensa.h"\n' + HELPERS)
    source = replace_exact(source, '  struct work_s work;           /* Supports worker thread operations */',
        '  struct work_s work;           /* Supports worker thread operations */\n  struct wdog_s watchdog;        /* Active DMA timeout */')
    source = replace_exact(source, '  bool streaming;                 /* Is I2S peripheral active? */',
        '  bool streaming;                 /* Is I2S peripheral active? */\n  bool capture;                   /* RX owns continuous TX clocks */\n  uint32_t clock_mclk;             /* Last MCLK programmed into hardware */')
    prototype = '''static void pixelbox_capture_clock(struct esp32s3_i2s_s *priv);
#ifdef I2S_HAVE_TX
static void pixelbox_tx_timeout(wdparm_t argument);
#endif
#ifdef I2S_HAVE_RX
static void pixelbox_rx_abort(struct esp32s3_i2s_s *priv, int error);
static void pixelbox_rx_timeout(wdparm_t argument);
#endif

'''
    source = replace_exact(source, '/* I2S methods (and close friends) */', prototype + '/* I2S methods (and close friends) */')

    for direction in ('tx', 'rx'):
        def start(body, direction=direction):
            old = f'  sq_addlast((sq_entry_t *)bfcontainer, &priv->{direction}.act);'
            return replace_exact(body, old, old + f'''
  if (bfcontainer->timeout)
    wd_start(&priv->{direction}.watchdog, bfcontainer->timeout,
             pixelbox_{direction}_timeout, (wdparm_t)priv);''')
        source = modify_function(source, f'i2s_{direction}dma_start', start)
        source = modify_function(source, f'i2s_{direction}_schedule', lambda body, d=direction:
            replace_exact(body, f'          sq_remfirst(&priv->{d}.act);',
                f'          wd_cancel(&priv->{d}.watchdog);\n          sq_remfirst(&priv->{d}.act);'))

    def tx_setup(body):
        body = replace_exact(body, 'calloc(bfcontainer->nbytes, 1)', 'pixelbox_dma_calloc(bfcontainer->nbytes, 1)')
        body = replace_exact(body, '  apb_free(bfcontainer->apb);',
            '  /* 引用保留至 TX callback 完成，错误路径同样只释放一次。 */')
        return replace_exact(body, '      return -bytes_queued;', '      return -EIO;')
    source = modify_function(source, 'i2s_txdma_setup', tx_setup)

    def rx_setup(body):
        body = replace_exact(body, '  inlink = bfcontainer->dma_link;', '''  inlink = bfcontainer->dma_link;
  bfcontainer->buf = pixelbox_dma_calloc(bfcontainer->nbytes, 1);
  if (bfcontainer->buf == NULL) return -ENOMEM;''')
        body = replace_exact(body, 'bfcontainer->apb->samp,', 'bfcontainer->buf,')
        return replace_exact(body, '      return -bytes_queued;', '      return -EIO;')
    source = modify_function(source, 'i2s_rxdma_setup', rx_setup)

    source = modify_function(source, 'i2s_tx_worker', lambda body: replace_exact(body,
        '      free(bfcontainer->buf);', '''      pixelbox_dma_free(bfcontainer->buf);
      apb_free(bfcontainer->apb);'''))

    def rx_worker(body):
        begin = body.index('      while (dmadesc != NULL &&')
        end = body.index('      /* Perform the RX transfer done callback */', begin)
        body = body[:begin] + '''      if (bfcontainer->result == OK)
        {
          /* RX 的 EOF 由硬件置位；逐个累计已交还 CPU 的描述符。 */
          while (dmadesc != NULL && !(dmadesc->ctrl & ESP32S3_DMA_CTRL_OWN))
            {
              bfcontainer->apb->nbytes +=
                (dmadesc->ctrl >> ESP32S3_DMA_CTRL_DATALEN_S) &
                ESP32S3_DMA_CTRL_DATALEN_V;
              dmadesc = dmadesc->next;
            }
          if (bfcontainer->apb->nbytes > bfcontainer->nbytes)
            {
              bfcontainer->apb->nbytes = 0;
              bfcontainer->result = -EIO;
            }
          else
            memcpy(bfcontainer->apb->samp, bfcontainer->buf,
                   bfcontainer->apb->nbytes);
        }

''' + body[end:]
        return replace_exact(body, '      apb_free(bfcontainer->apb);',
            '      pixelbox_dma_free(bfcontainer->buf);\n      apb_free(bfcontainer->apb);')
    source = modify_function(source, 'i2s_rx_worker', rx_worker)

    source = modify_function(source, 'i2s_rx_schedule', lambda body:
        replace_exact(body, '''      while (bfdesc->next != NULL &&
             (bfdesc->next->ctrl & ESP32S3_DMA_CTRL_EOF))''',
        '''      while (bfdesc->next != NULL &&
             !(bfdesc->ctrl & ESP32S3_DMA_CTRL_EOF))'''))

    # 中断与超时在同一 spinlock 下操作队列，兼容 SMP。
    for direction in ('tx', 'rx'):
        source = modify_function(source, f'i2s_{direction}_interrupt', lambda body:
            replace_exact(replace_exact(body,
                '  struct esp32s3_dmadesc_s *cur = NULL;',
                '  struct esp32s3_dmadesc_s *cur = NULL;\n  irqstate_t flags = spin_lock_irqsave(&priv->slock);'),
                '  return 0;', '  spin_unlock_irqrestore(&priv->slock, flags);\n  return 0;'))

    for name in ('i2s_send', 'i2s_receive'):
        def submit(body):
            body = replace_exact(body, '      int ret = OK;',
                '      int ret = OK;\n      bool locked = false;\n      bool referenced = false;')
            body = replace_exact(body, '      /* Add a reference to the audio buffer */',
                '      locked = true;\n      bfcontainer->buf = NULL;\n\n      /* Add a reference to the audio buffer */')
            body = replace_exact(body, '      apb_reference(apb);', '      apb_reference(apb);\n      referenced = true;')
            return replace_exact(body, '''errout_with_buf:
      nxmutex_unlock(&priv->lock);
      i2s_buf_free(priv, bfcontainer);''', '''errout_with_buf:
      if (referenced)
        {
          pixelbox_dma_free(bfcontainer->buf);
          apb_free(apb);
        }
      if (locked) nxmutex_unlock(&priv->lock);
      i2s_buf_free(priv, bfcontainer);''')
        source = modify_function(source, name, submit)

    # 同率播放/录音并发时不能停止另一方向的共用时钟。
    for direction in ('tx', 'rx'):
        for suffix, parameter, state in (('samplerate', 'rate', 'rate'), ('datawidth', 'bits', 'data_width')):
            same = f'priv->{state} == (uint32_t){parameter}'
            if suffix == 'samplerate':
                same += ' && priv->clock_mclk == priv->mclk_freq'
            source = modify_function(source, f'i2s_{direction}{suffix}', lambda body, d=direction, p=parameter, s=state:
                replace_exact(body, f'      i2s_{d}_channel_stop(priv);',
                    f'      if ({same}) return {p};\n      i2s_{d}_channel_stop(priv);'))

    source = modify_function(source, 'i2s_check_mclkfrequency', lambda body:
        replace_exact(body, '  int i;', '''  int i;
  /* ES8311/ES7210 共享 MCLK，16bit 模式固定 256fs，避免跨采样率沿用 512fs。 */
  if (priv->config->role == I2S_ROLE_MASTER && priv->data_width == 16)
    i2s_setmclkfrequency((struct i2s_dev_s *)priv, priv->rate * 256);'''))

    source = modify_function(source, 'i2s_txchannels', lambda body:
        replace_exact(body, '      i2s_tx_channel_stop(priv);',
            '      if (priv->channels == channels) return OK;\n      i2s_tx_channel_stop(priv);'))
    # 整数分频时 numerator=0；寄存器 X/Y 必须直接归零，不能取模/除零。
    source = modify_function(source, 'i2s_set_clock', lambda body:
        replace_exact(replace_exact(replace_exact(body, '(denominator % numerator)',
            '(numerator ? denominator % numerator : 0)', 2),
            '(int)(floor(denominator / numerator) - 1)',
            '(numerator ? (int)(floor(denominator / numerator) - 1) : 0)', 2),
            '  return rate;', '  priv->clock_mclk = priv->mclk_freq;\n  return rate;'))
    source = modify_function(source, 'i2s_set_datawidth', lambda body:
        replace_exact(body,
            'FIELD_TO_VALUE(I2S_RX_TDM_WS_WIDTH, 1)',
            'FIELD_TO_VALUE(I2S_RX_TDM_WS_WIDTH, priv->data_width - 1)'))

    # Capture ioctl 仅控制 RX，与 ES8311 的 AUDIOIOC_STOP 独立。
    def ioctl(body):
        return replace_exact(body, '  switch (cmd)\n    {', '''  switch (cmd)
    {
#ifdef I2S_HAVE_RX
      case ESP32S3_I2S_CAPTURE_START:
      case ESP32S3_I2S_CAPTURE_STOP:
        {
        if (!priv->config->rx_en) return -ENOTSUP;
        int locked = nxmutex_lock(&priv->lock);
        if (locked < 0) return locked;
        if (cmd == ESP32S3_I2S_CAPTURE_STOP)
          pixelbox_rx_abort(priv, -ECANCELED);
        irqstate_t flags = spin_lock_irqsave(&priv->slock);
        priv->capture = cmd == ESP32S3_I2S_CAPTURE_START;
        pixelbox_capture_clock(priv);
        spin_unlock_irqrestore(&priv->slock, flags);
        nxmutex_unlock(&priv->lock);
        return OK;
        }
#endif''')
    source = modify_function(source, 'i2s_ioctl', ioctl)
    offset, _ = function_body(source, 'i2s_ioctl')
    signature = source.rfind('\nstatic int i2s_ioctl', 0, offset)
    if signature < 0:
        raise ValueError('I2S ioctl signature drift')
    source = source[:signature] + '\n' + CLOCK_AND_TIMEOUT + source[signature:]
    return MARKER + '\n' + source


def patch_header(source: str) -> str:
    if HEADER_MARKER in source:
        return source
    insertion = HEADER_MARKER + '''
#define ESP32S3_I2S_CAPTURE_START 0x50494301
#define ESP32S3_I2S_CAPTURE_STOP  0x50494302

'''
    return replace_exact(source, '#define ESP32S3_I2S0 0', insertion + '#define ESP32S3_I2S0 0')


def apply_i2s_capture_patch(nuttx_root: Path) -> bool:
    root = Path(nuttx_root) / 'arch/xtensa/src/esp32s3'
    source, header = root / 'esp32s3_i2s.c', root / 'esp32s3_i2s.h'
    original, original_header = source.read_text(), header.read_text()
    patched, patched_header = patch_text(original), patch_header(original_header)
    if patched == original and patched_header == original_header:
        return False
    source.write_text(patched)
    header.write_text(patched_header)
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('nuttx_root', type=Path)
    args = parser.parse_args()
    print('patched' if apply_i2s_capture_patch(args.nuttx_root) else 'already patched')
