// config/source_catalog.json 是数据源的唯一配置入口；页面与采集器读取同一份文件。
import sourceCatalog from "../../config/source_catalog.json" with { type: "json" };

export const SOURCE_CATALOG = sourceCatalog;
