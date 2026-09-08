#include "speech_core.hpp"

#include <cassert>
#include <cstdio>
#include <vector>

using namespace speech;
constexpr int ESP_OK = 0;
constexpr const char* kTag = "px.speech";
template <typename... Args> static void test_log(const char*, const char*, Args...) {}
#define ESP_LOGI(...) test_log(__VA_ARGS__)

static std::vector<std::string> calls;
static bool fail_clear = false, fail_add = false, fail_update = false;
static std::string command;
static float applied_threshold = -1;
static int64_t esp_timer_get_time() { return 0; }
static int esp_mn_commands_clear() {
    calls.push_back("clear");
    if (fail_clear) return -1;
    command.clear();
    return ESP_OK;
}
static int esp_mn_commands_add(int id, const char* pinyin) {
    assert(id == 1);
    calls.push_back("add");
    if (fail_add) return -1;
    command = pinyin;
    return ESP_OK;
}
static void* esp_mn_commands_update() {
    calls.push_back("update");
    return fail_update ? &fail_update : nullptr;
}
struct FakeInterface {
    void clean(void*) { calls.push_back("clean"); }
    int set_det_threshold(void*, float threshold) {
        calls.push_back("threshold");
        applied_threshold = threshold;
        return 0;
    }
};
struct Model {
    FakeInterface* iface;
    void* data = nullptr;
    std::string registered_pinyin;
    // 由检查脚本提取实际固件方法，确保缓存及失败恢复测试覆盖生产流程。
#include "wake_registration.inc"
};

int main() {
    FakeInterface iface;
    Model model{&iface, nullptr, {}};
    WakeConfig first{"你好小川", "ni hao xiao chuan", 0.30};
    assert(model.configure_wake(first) == nullptr);
    assert(command == first.pinyin && applied_threshold == 0.30f);
    assert((calls == std::vector<std::string>{"clean", "clear", "add", "update", "threshold"}));

    calls.clear();
    first.threshold = 0.15;
    assert(model.configure_wake(first) == nullptr);
    assert(applied_threshold == 0.15f);
    assert((calls == std::vector<std::string>{"clean", "threshold"}));

    calls.clear();
    WakeConfig second{"小爱同学", "xiao ai tong xue", 0.85};
    assert(model.configure_wake(second) == nullptr);
    assert(command == second.pinyin && applied_threshold == 0.85f);
    assert((calls == std::vector<std::string>{"clean", "clear", "add", "update", "threshold"}));

    calls.clear();
    assert(model.configure_wake({}) != nullptr);
    assert(calls.empty() && command == second.pinyin);

    for (bool* failure : {&fail_clear, &fail_add, &fail_update}) {
        *failure = true;
        assert(model.configure_wake(first) != nullptr);
        assert(model.registered_pinyin.empty());
        assert(applied_threshold == 0.85f);
        *failure = false;
        calls.clear();
        assert(model.configure_wake(second) == nullptr);
        assert(command == second.pinyin && applied_threshold == 0.85f);
        assert((calls == std::vector<std::string>{"clean", "clear", "add", "update", "threshold"}));
    }
    std::puts("wake registration: phrase replacement, threshold updates, cache reuse and registration failure recovery passed");
}
