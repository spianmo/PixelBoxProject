#!/usr/bin/env python3
"""对受控 NuttX 快照应用 ES8311 修复；源码漂移时停止，不做模糊替换。"""
from pathlib import Path
import argparse
import hashlib
import re

OLD_MARKER = "/* PixelBox ES8311 transport fixes v1. */"
MARKER = "/* PixelBox ES8311 transport fixes v2. */"
SOURCE_SHA256 = "3995b6da17cee6c675a43d38ecd61393ffc827dbe00f12b870dfd10f094d59ba"
V1_SHA256 = "630972ce69c3cbe427c295282a4a883834daba6daa94a459a6e8048dffa9e921"
V2_SHA256 = "524d30b87076b28ae38c9a2955d022b9af350cb659de8215a961f2f46fff27bd"


def function_body(source: str, name: str) -> tuple[int, int]:
    pattern = rf"(?m)^static\b[^\n]*\b{re.escape(name)}\([^;]*?\)[^;{{]*\{{"
    matches = list(re.finditer(pattern, source))
    if len(matches) != 1:
        raise ValueError(f"ES8311: expected one definition of {name}, got {len(matches)}")
    start = matches[0].end() - 1
    depth = 1
    end = start + 1
    while depth and end < len(source):
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    if depth:
        raise ValueError(f"ES8311: unbalanced function {name}")
    return start, end


def replace_exact(text: str, old: str, new: str, count: int = 1) -> str:
    actual = text.count(old)
    if actual != count:
        raise ValueError(f"ES8311 source drift: expected {count}, got {actual}: {old[:100]!r}")
    return text.replace(old, new)


def modify_function(source: str, name: str, transform) -> str:
    start, end = function_body(source, name)
    return source[:start] + transform(source[start:end]) + source[end:]


def direction_config(body: str, suffix: str, argument: str) -> str:
    # 仅配置实际启用的方向；TX-only 芯片不能先因 RX 的 ENOTTY 提前退出。
    for direction, module in (("RX", "ADC"), ("TX", "DAC")):
        pattern = (rf"  ret = I2S_{direction}{suffix}\(priv->i2s, priv->{argument}\);\n"
                   rf"  if \(ret < 0\)\n    \{{\n"
                   rf"      auderr\(\"I2S_{direction}{suffix} failed.\\n\"\);\n"
                   rf"      return ret;\n    \}}")
        replacement = f"""  if (priv->audio_mode == ES_MODULE_{module} ||
      priv->audio_mode == ES_MODULE_ADC_DAC)
    {{
      ret = (int32_t)I2S_{direction}{suffix}(priv->i2s, priv->{argument});
      if (ret <= 0)
        {{
          return ret < 0 ? ret : -EIO;
        }}
    }}"""
        body, count = re.subn(pattern, lambda _: replacement, body)
        if count != 1:
            raise ValueError(f"ES8311: unexpected {direction}{suffix} implementation")
    return body


def patch_v1(source: str) -> str:
    source = modify_function(source, "es8311_setbitspersample",
                             lambda body: direction_config(body, "DATAWIDTH", "bpsamp"))

    def sample_rate(body: str) -> str:
        body = direction_config(body, "SAMPLERATE", "samprate")
        # ESP32-S3 在设置采样率时才重新选择 MCLK；系数必须使用新 MCLK。
        start = body.index("  priv->mclk = I2S_GETMCLKFREQUENCY")
        end = body.index("  if (priv->audio_mode", start)
        coeff = body[start:end]
        body = body[:start] + body[end:]
        return replace_exact(body, "  ret = 0;\n  regconfig =", coeff + "  ret = 0;\n  regconfig =")

    source = modify_function(source, "es8311_setsamplerate", sample_rate)

    def configure(body: str) -> str:
        body = replace_exact(body,
            "ret = es8311_setsamplerate(priv) == -ENOTTY ? OK : ret;",
            "ret = es8311_setsamplerate(priv);", 2)
        body = replace_exact(body,
            "ret = es8311_setbitspersample(priv) == -ENOTTY ? OK : ret;",
            "ret = es8311_setbitspersample(priv);", 2)
        body = replace_exact(body,
            "es8311_setvolume(priv, priv->audio_mode, volume);",
            "ret = es8311_setvolume(priv, priv->audio_mode, volume);")
        body = replace_exact(body,
            "es8311_setmute(priv, ES_MODULE_DAC, mute);",
            "ret = es8311_setmute(priv, ES_MODULE_DAC, mute);")
        # 明确设置声道，不能接受了 channels 却仍使用 I2S 的上一次配置。
        for mode, direction in (("output", "TX"), ("input", "RX")):
            old = f"        es8311_audio_{mode}(priv);\n        es8311_reset(priv);"
            new = old + f"""

        ret = I2S_{direction}CHANNELS(priv->i2s, caps->ac_channels);
        if (ret < 0)
          {{
            break;
          }}"""
            body = replace_exact(body, old, new)
        return body

    source = modify_function(source, "es8311_configure", configure)

    def process_done(body: str) -> str:
        needle = "  leave_critical_section(flags);\n\n  /* Now send a message"
        return replace_exact(body, needle, """  leave_critical_section(flags);

  /* I2S 错误必须终结本次播放；不能只记日志再上报成功完成。 */
  if (result < 0)
    {
#ifndef CONFIG_AUDIO_EXCLUDE_STOP
      priv->terminating = true;
#else
      priv->running = false;
#endif
#ifdef CONFIG_AUDIO_MULTI_SESSION
      priv->dev.upper(priv->dev.priv, AUDIO_CALLBACK_IOERR, apb,
                      (uint16_t)-result, NULL);
#else
      priv->dev.upper(priv->dev.priv, AUDIO_CALLBACK_IOERR, apb,
                      (uint16_t)-result);
#endif
    }

  /* Now send a message""")

    source = modify_function(source, "es8311_processdone", process_done)

    def process_begin(body: str) -> str:
        body = replace_exact(body,
            "         dq_peek(&priv->pendq) != NULL && !priv->paused)",
            """         dq_peek(&priv->pendq) != NULL && !priv->paused
#ifndef CONFIG_AUDIO_EXCLUDE_STOP
         && !priv->terminating
#endif
         )""")
        return replace_exact(body,
            '          auderr("I2S transfer failed: %d\\n", ret);\n          break;',
            """          auderr("I2S transfer failed: %d\\n", ret);
          /* SEND 没有接收该缓冲，也不会回调；按同一回收路径归还引用。 */
          es8311_processdone(priv->i2s, apb, priv, ret);
          break;""")

    source = modify_function(source, "es8311_processbegin", process_begin)

    def start(body: str) -> str:
        body = replace_exact(body,
            "      pthread_join(priv->threadid, &value);",
            "      pthread_join(priv->threadid, &value);\n      priv->threadid = 0;")
        body = replace_exact(body,
            "                       (pthread_addr_t)priv);\n  if (ret != OK)",
            "                       (pthread_addr_t)priv);\n  pthread_attr_destroy(&tattr);\n  if (ret != OK)")
        return replace_exact(body,
            '      auderr("pthread_create failed: %d\\n", ret);',
            """      auderr("pthread_create failed: %d\\n", ret);
      priv->threadid = 0;
      file_mq_close(&priv->mq);
      file_mq_unlink(priv->mqname);
      return -ret;""")

    source = modify_function(source, "es8311_start", start)

    def release(body: str) -> str:
        body = replace_exact(body, "  FAR void *value;\n  int ret;",
                             "  FAR void *value;\n  FAR struct ap_buffer_s *apb;\n  int ret;")
        return replace_exact(body, """  ret = nxmutex_lock(&priv->pendlock);

  /* Really we should free any queued buffers here */

  priv->reserved = false;""", """  ret = nxmutex_lock(&priv->pendlock);
  if (ret < 0)
    {
      return ret;
    }

  /* START 失败时没有 worker 回收预入队缓冲；归还 lower 持有的引用。
   * 调用者仍持有自己的 APB 引用，收到 DEQUEUE 后才释放它。
   */
  while ((apb = (FAR struct ap_buffer_s *)dq_remfirst(&priv->pendq)) != NULL)
    {
      apb_free(apb);
#ifdef CONFIG_AUDIO_MULTI_SESSION
      priv->dev.upper(priv->dev.priv, AUDIO_CALLBACK_DEQUEUE, apb, OK, NULL);
#else
      priv->dev.upper(priv->dev.priv, AUDIO_CALLBACK_DEQUEUE, apb, OK);
#endif
    }

  priv->running = false;
  priv->reserved = false;""")

    source = modify_function(source, "es8311_release", release)
    return OLD_MARKER + "\n" + source


JOIN_WORKER = r'''
/* upper->lock 串行控制入口；不能持有 pendlock 等待 worker 回收缓冲。
 * mq 由控制入口持有到成功 join 后，worker 完成不代表控制者已回收。
 */
static int es8311_join_worker(FAR struct es8311_dev_s *priv, bool stop)
{
  struct audio_msg_s msg;
  FAR void *value;
  irqstate_t flags;
  bool running;
  int ret;

  if (priv->threadid == 0)
    {
      return OK;
    }

  flags = enter_critical_section();
  running = priv->running;
  if (running && stop)
    {
#ifndef CONFIG_AUDIO_EXCLUDE_STOP
      priv->terminating = true;
#else
      priv->running = false;
#endif
    }
  leave_critical_section(flags);

  if (running)
    {
      if (!stop)
        {
          return -EBUSY;
        }

      /* 先发布停止状态，再有界唤醒。队列满时已有消息可唤醒 worker；
       * 即使 worker 已退出，也不能在无人消费的满队列里永久等待。
       */
      msg.msg_id = AUDIO_MSG_STOP;
      msg.u.data = 0;
      ret = file_mq_ticksend(&priv->mq, (FAR const char *)&msg, sizeof(msg),
                            CONFIG_ES8311_MSG_PRIO, 1);
      if (ret < 0 && ret != -ETIMEDOUT && ret != -EAGAIN)
        {
          return ret;
        }
    }

  ret = pthread_join(priv->threadid, &value);
  if (ret != OK)
    {
      /* join 失败时保留所有权，调用者不得把仍被引用的缓冲当成已释放。 */
      return -ret;
    }

  priv->threadid = 0;
  ret = file_mq_close(&priv->mq);
  if (ret < 0)
    {
      return ret;
    }

  return file_mq_unlink(priv->mqname);
}

'''


def patch_v2(source: str) -> str:
    """仅从精确 v1 结果升级，控制路径拥有队列的整个生命周期。"""
    source = replace_exact(source, OLD_MARKER, MARKER)
    anchor = "\n#ifdef CONFIG_AUDIO_MULTI_SESSION\nstatic int es8311_start(FAR struct audio_lowerhalf_s *dev, FAR void *session)\n"
    source = replace_exact(source, anchor, "\n" + JOIN_WORKER + anchor)

    def start(body: str) -> str:
        body = replace_exact(body, "  FAR void *value;\n", "")
        body = replace_exact(body, '  audinfo("ES8311 Start\\n");', '''  audinfo("ES8311 Start\\n");

  /* 先回收旧线程及其队列，不能先覆盖旧 worker 仍可能使用的句柄。 */
  ret = es8311_join_worker(priv, false);
  if (ret < 0)
    {
      return ret;
    }''')
        body = replace_exact(body, '''  /* Join any old worker thread we had created to prevent a memory leak */

  if (priv->threadid != 0)
    {
      audinfo("Joining old thread\\n");
      pthread_join(priv->threadid, &value);
      priv->threadid = 0;
    }

''', "")
        body = replace_exact(body, '  audinfo("Starting worker thread\\n");', '''  /* 在线程创建前发布状态；早到的 STOP 不能被 worker 入口覆盖。 */
#ifndef CONFIG_AUDIO_EXCLUDE_STOP
  priv->terminating = false;
#endif
  priv->running = true;

  audinfo("Starting worker thread\\n");''')
        return replace_exact(body, "      priv->threadid = 0;\n      file_mq_close(&priv->mq);",
                             "      priv->running = false;\n      priv->threadid = 0;\n      file_mq_close(&priv->mq);")

    source = modify_function(source, "es8311_start", start)

    def stop(body: str) -> str:
        body = replace_exact(body, "  struct audio_msg_s term_msg;\n  FAR void *value;\n", "  int joined;\n")
        body = replace_exact(body, '  audinfo("ES8311 Stop\\n");', '''  audinfo("ES8311 Stop\\n");

  if (priv->threadid == 0)
    {
      return OK;
    }''')
        return replace_exact(body, '''  /* Send a message to stop all audio streaming */

  term_msg.msg_id = AUDIO_MSG_STOP;
  term_msg.u.data = 0;
  file_mq_send(&priv->mq, (FAR const char *)&term_msg, sizeof(term_msg),
               CONFIG_ES8311_MSG_PRIO);

  /* Join the worker thread */

  pthread_join(priv->threadid, &value);
  priv->threadid = 0;''', '''  joined = es8311_join_worker(priv, true);
  if (joined < 0)
    {
      return joined;
    }''')

    source = modify_function(source, "es8311_stop", stop)

    def release(body: str) -> str:
        body = replace_exact(body, "  FAR void *value;\n", "")
        return replace_exact(body, '''  /* Join any old worker thread we had created to prevent a memory leak */

  if (priv->threadid != 0)
    {
      pthread_join(priv->threadid, &value);
      priv->threadid = 0;
    }''', '''  /* RELEASE 也必须处理未 STOP 的活动线程；失败时不释放 APB 引用。 */
  ret = es8311_join_worker(priv, true);
  if (ret < 0)
    {
      return ret;
    }''')

    source = modify_function(source, "es8311_release", release)

    def worker(body: str) -> str:
        body = replace_exact(body, "  unsigned int prio;", "  unsigned int prio;\n  irqstate_t flags;")
        body = replace_exact(body, '''#ifndef CONFIG_AUDIO_EXCLUDE_STOP
  priv->terminating = false;
#endif /* CONFIG_AUDIO_EXCLUDE_STOP */

  priv->running = true;

''', "")
        return replace_exact(body, '''  /* Close the message queue */

  file_mq_close(&priv->mq);
  file_mq_unlink(priv->mqname);''', '''  /* 完成后只发布状态；队列由成功 join 的控制入口关闭。 */
  flags = enter_critical_section();
  priv->running = false;
  leave_critical_section(flags);''')

    return modify_function(source, "es8311_workerthread", worker)


def patch_text(source: str) -> str:
    digest = hashlib.sha256(source.encode()).hexdigest()
    if digest == V2_SHA256:
        return source
    if digest == SOURCE_SHA256:
        return patch_v2(patch_v1(source))
    if digest == V1_SHA256:
        return patch_v2(source)
    raise ValueError(f"ES8311 source drift: unrecognized snapshot {digest}")


def apply_es8311_patch(nuttx_root: Path) -> bool:
    path = Path(nuttx_root) / "drivers/audio/es8311.c"
    original = path.read_text()
    updated = patch_text(original)
    if updated == original:
        return False
    path.write_text(updated)
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("nuttx_root", type=Path)
    args = parser.parse_args()
    print("patched" if apply_es8311_patch(args.nuttx_root) else "already patched")
