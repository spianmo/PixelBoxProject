#include "hal_display/dma_pipeline.hpp"
#include "hal_display/gfx.hpp"
#include "src/draw/sw/lv_draw_sw.h"
#include <cassert>
#include <cstdio>
#include <vector>

int main()
{
    // 模拟异步面板：只有 wait 才完成读取，提前覆盖在途内存会让快照比较失败。
    uint16_t a[6]{}, b[6]{};
    hal_display::DmaPipeline dma;
    dma.buffers[0] = a;
    dma.buffers[1] = b;
    uint16_t *inflight = nullptr;
    std::vector<uint16_t> snapshot;
    std::vector<char> events;
    bool timeout = false, send_error = false;
    int sequence = 0;
    auto prepare = [&](uint16_t *buffer) {
        assert(buffer != inflight);
        events.push_back('P');
        for (int i = 0; i < 6; ++i) buffer[i] = ++sequence;
    };
    auto send = [&](uint16_t *buffer) {
        assert(inflight == nullptr);
        events.push_back('S');
        if (send_error) return 2;
        inflight = buffer;
        snapshot.assign(buffer, buffer + 6);
        return 0;
    };
    auto wait = [&] {
        assert(inflight);
        assert(snapshot == std::vector<uint16_t>(inflight, inflight + 6));
        events.push_back('W');
        if (timeout) return 1;
        inflight = nullptr;
        return 0;
    };
    assert(dma.drain(wait) == 0);
    assert(dma.submit(prepare, send, wait) == 0 && inflight == a);
    assert(dma.submit(prepare, send, wait) == 0 && inflight == b);
    assert((events == std::vector<char>{'P','S','P','W','S'}));
    timeout = true;
    assert(dma.submit(prepare, send, wait) == 1 && inflight == b);
    assert(dma.drain(wait) == 1 && inflight == b);
    assert(dma.submit(prepare, send, wait) == 1 && inflight == b);
    timeout = false;
    assert(dma.drain(wait) == 0 && inflight == nullptr);
    send_error = true;
    assert(dma.submit(prepare, send, wait) == 2 && inflight == nullptr);
    assert(dma.drain(wait) == 0);
    send_error = false;
    assert(dma.submit(prepare, send, wait) == 0 && inflight == a);
    assert(dma.drain(wait) == 0);

    // 非方形画布的四向旋转 + 面板字节序，检查原画布没有被交换或改写。
    for (int rotation : {0, 90, 180, 270}) {
        const int w = rotation % 180 ? 2 : 3, h = rotation % 180 ? 3 : 2;
        uint16_t pixels[] = {0xf800, 0x07e0, 0x001f, 0x1234, 0xffff, 0};
        gfx::Surface source{pixels, w, h, w};
        const std::vector<uint16_t> before(pixels, pixels + 6);
        uint16_t output[8] = {0x5555, 0, 0, 0, 0, 0, 0, 0xaaaa};
        gfx::gather_rotated_rect(source, output + 1, rotation, 0, 0, 3, 2);
        lv_draw_sw_rgb565_swap(output + 1, 6);
        for (int y = 0; y < 2; ++y) for (int x = 0; x < 3; ++x) {
            int sx = x, sy = y;
            if (rotation == 90) { sx = y; sy = h - 1 - x; }
            if (rotation == 180) { sx = w - 1 - x; sy = h - 1 - y; }
            if (rotation == 270) { sx = w - 1 - y; sy = x; }
            const auto *bytes = reinterpret_cast<const uint8_t *>(output + 1 + y * 3 + x);
            assert(bytes[0] == (source.row(sy)[sx] >> 8));
            assert(bytes[1] == (source.row(sy)[sx] & 255));
        }
        assert(output[0] == 0x5555 && output[7] == 0xaaaa);
        assert(before == std::vector<uint16_t>(pixels, pixels + 6));
    }
    puts("DMA 管线：交替、并行准备、超时保护、提交失败恢复、旋转字节序均通过");
}
