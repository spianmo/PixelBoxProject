#pragma once

#include <cstdint>

namespace hal_display {

// 两个缓冲、最多一笔在途事务：准备下一带时，上一带仍可由 DMA 发送。
// 错误后保留 pending；调用方必须 drain 成功后才能旋转、关屏或释放缓冲。
class DmaPipeline {
public:
    uint16_t *buffers[2] = {};

    template <typename Wait>
    int drain(Wait wait)
    {
        if (!pending_) return 0;
        const int err = wait();
        if (err == 0) pending_ = false;
        return err;
    }

    template <typename Prepare, typename Send, typename Wait>
    int submit(Prepare prepare, Send send, Wait wait)
    {
        // next_ 永远不指向在途缓冲；先准备，再等待，才能实现 CPU/DMA 重叠。
        prepare(buffers[next_]);
        const int err = drain(wait);
        if (err != 0) return err;
        const int sent = send(buffers[next_]);
        if (sent == 0) {
            pending_ = true;
            next_ ^= 1;
        }
        return sent;
    }

private:
    unsigned next_ = 0;
    bool pending_ = false;
};

}  // namespace hal_display
