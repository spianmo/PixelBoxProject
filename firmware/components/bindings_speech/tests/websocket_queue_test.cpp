#include <algorithm>
#include <cassert>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

// 只替换 FreeRTOS 调度边界；被测 ws_submit_work 从生产源文件提取，不复制实现。
using UBaseType_t = unsigned;
constexpr int CONFIG_JSVM_TASK_PRIORITY = 5, configMAX_PRIORITIES = 25;
UBaseType_t uxTaskPriorityGet(void*) { return 5; }
void vTaskPrioritySet(void*, UBaseType_t) {}
struct WsClient {
    std::mutex work_mutex;
    std::deque<std::function<void()>> work;
    bool work_running = false;
};
using WsPtr = std::shared_ptr<WsClient>;
namespace pxjs {
std::deque<std::function<void()>> scheduled;
bool available = true;
bool worker_submit(std::function<void()> job, bool cleanup) {
    assert(cleanup);
    if (!available) return false;
    scheduled.push_back(std::move(job));
    return true;
}
}
#include "websocket_queue.inc"

int main() {
    auto ws = std::make_shared<WsClient>();
    std::vector<int> completed;
    assert(ws_submit_work(ws, [&] { completed.push_back(1); }));
    assert(ws_submit_work(ws, [&] { completed.push_back(2); }));
    assert(ws_submit_work(ws, [&] { completed.push_back(3); }));
    assert(completed.empty() && pxjs::scheduled.size() == 1);
    auto drain = std::move(pxjs::scheduled.front()); pxjs::scheduled.pop_front();
    drain();
    assert((completed == std::vector<int>{1, 2, 3}));
    assert(!ws->work_running);
    pxjs::available = false;
    assert(!ws_submit_work(ws, [&] { assert(false); }));
    assert(ws->work.empty() && !ws->work_running);
    pxjs::available = true;
    assert(ws_submit_work(ws, [&] {
        // 模拟发送中追加 close/destroy，追加操作不能死锁或丢失。
        std::thread producer([&] { assert(ws_submit_work(ws, [&] { completed.push_back(5); })); });
        producer.join();
        completed.push_back(4);
    }));
    drain = std::move(pxjs::scheduled.front()); pxjs::scheduled.pop_front();
    drain();
    assert((completed == std::vector<int>{1, 2, 3, 4, 5}));
    assert(pxjs::scheduled.empty() && !ws->work_running);
    std::cout << "WebSocket background FIFO, cleanup order and worker retry passed\n";
}
