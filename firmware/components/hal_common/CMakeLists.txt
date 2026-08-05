# hal_common — 板级抽象接口 (纯头文件组件, 不依赖任何业务组件)
# 具体实现由 boards 组件按 Kconfig 选择的板型提供。
idf_component_register(INCLUDE_DIRS include)
