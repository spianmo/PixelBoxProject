#pragma once

#include <cstdint>
#include <mutex>

namespace jsvm {

// One replaceable value, with an epoch to reject producers from a stopped stream.
template <typename T> class LatestValue {
public:
    uint32_t reset() {
        std::lock_guard<std::mutex> lock(mutex_);
        pending_ = false;
        return ++epoch_;
    }

    // True only when the consumer needs waking. No allocation or queue wait.
    bool publish(uint32_t epoch, const T &value) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (epoch != epoch_) return false;
        value_ = value;
        const bool wake = !pending_;
        pending_ = true;
        return wake;
    }

    bool take(T &value) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!pending_) return false;
        value = value_;
        pending_ = false;
        return true;
    }

    bool pending() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return pending_;
    }

private:
    mutable std::mutex mutex_;
    T value_{};
    uint32_t epoch_ = 0;
    bool pending_ = false;
};

} // namespace jsvm
