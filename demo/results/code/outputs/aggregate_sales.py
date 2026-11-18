#!/usr/bin/env python3
"""按商品汇总销售金额（amount）。

仅使用 Python 标准库：
- csv      读取 CSV
- decimal  金额用十进制精确计算，避免浮点误差
- datetime 解析日期以支持按月份筛选
- argparse 命令行参数

用法：
    python3 aggregate_sales.py inputs/sales.csv
    python3 aggregate_sales.py path.csv --format csv
    python3 aggregate_sales.py path.csv --month 2026-01
"""

from __future__ import annotations

import argparse
import csv
import datetime
import re
import sys
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Iterable, Mapping, Sequence

__all__ = [
    "SalesRow",
    "aggregate_by_product",
    "filter_by_month",
    "format_report",
    "read_sales_csv",
    "row_month",
    "validate_month",
    "main",
]

#: 必需的列名
REQUIRED_COLUMNS = ("product", "amount")

#: 月份参数格式：YYYY-MM
MONTH_RE = re.compile(r"^\d{4}-(?:0[1-9]|1[0-2])$")


class SalesRow:
    """一条销售记录。

    Args:
        date: 原始日期文本（可能是空字符串）。
        product: 商品名。
        amount: 金额。
        month: 解析出的 ``YYYY-MM``；无法解析时为 None。
        line_no: 该记录在 CSV 中的行号（用于报错定位）。
    """

    __slots__ = ("date", "product", "amount", "month", "line_no")

    def __init__(
        self,
        date: str,
        product: str,
        amount: Decimal,
        month: str | None = None,
        line_no: int | None = None,
    ) -> None:
        self.date = date
        self.product = product
        self.amount = amount
        self.month = month
        self.line_no = line_no

    def __repr__(self) -> str:  # pragma: no cover - 仅用于调试
        return (
            f"SalesRow(date={self.date!r}, product={self.product!r}, "
            f"amount={self.amount!r}, month={self.month!r})"
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, SalesRow):
            return NotImplemented
        return (self.date, self.product, self.amount) == (other.date, other.product, other.amount)


#: 支持的日期格式（依次尝试）
DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d", "%Y-%m-%dT%H:%M:%S")


def parse_date(text: str) -> datetime.date | None:
    """把日期文本解析为 ``datetime.date``；无法解析时返回 None。

    支持 ``YYYY-MM-DD``、``YYYY/MM/DD``、``YYYYMMDD`` 及 ISO 日期时间。
    """
    text = (text or "").strip()
    if not text:
        return None
    try:
        return datetime.date.fromisoformat(text)
    except ValueError:
        pass
    for fmt in DATE_FORMATS:
        try:
            return datetime.datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def row_month(row: SalesRow) -> str | None:
    """返回该记录所属月份 ``YYYY-MM``；无法确定时返回 None。"""
    if row.month:
        return row.month
    parsed = parse_date(row.date)
    return f"{parsed.year:04d}-{parsed.month:02d}" if parsed else None


def validate_month(month: str) -> str:
    """校验 ``YYYY-MM`` 月份字符串。

    Raises:
        ValueError: 格式不合法。
    """
    if not MONTH_RE.match(month):
        raise ValueError(
            f"月份格式不合法: {month!r}，应为 YYYY-MM（例如 2026-01）"
        )
    return month


def filter_by_month(rows: Iterable[SalesRow], month: str) -> list[SalesRow]:
    """筛选出指定月份的记录。

    Args:
        rows: 记录列表。
        month: ``YYYY-MM`` 月份字符串。

    Raises:
        ValueError: 月份格式不合法，或某条记录缺少可解析的日期。
    """
    validate_month(month)
    selected: list[SalesRow] = []
    for row in rows:
        row_m = row_month(row)
        if row_m is None:
            where = f"第 {row.line_no} 行" if row.line_no else "某行"
            raise ValueError(
                f"{where} 的日期无法解析（{row.date!r}），无法按月份 {month} 筛选"
            )
        if row_m == month:
            selected.append(row)
    return selected


def read_sales_csv(path: str | Path, require_date: bool = False) -> list[SalesRow]:
    """从 CSV 文件读取销售记录。

    - 空行与完全空白的行会被跳过。
    - ``amount`` 列按十进制数解析，允许带符号与小数。
    - ``date`` 列尽力解析为 ``YYYY-MM``；解析失败不影响读取（除非 require_date=True）。
    - 缺少必需列、金额非法时抛出 ValueError。

    Args:
        path: CSV 文件路径。
        require_date: 为 True 时 ``date`` 列必须存在，否则抛出 ValueError。

    Raises:
        ValueError: 表头缺少必需列，或某行的 amount 不是合法数字。
    """
    path = Path(path)
    rows: list[SalesRow] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = reader.fieldnames or []
        headers = {name.strip() for name in fieldnames if name}
        required = list(REQUIRED_COLUMNS)
        if require_date:
            required.append("date")
        missing = [c for c in required if c not in headers]
        if missing:
            raise ValueError(f"CSV 缺少必需的列: {', '.join(missing)}（实际表头: {fieldnames}）")

        for line_no, raw in enumerate(reader, start=2):
            record = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in raw.items() if k}
            if not any(record.values()):
                continue  # 跳过空行
            product = record.get("product", "")
            amount_text = record.get("amount", "")
            if not product:
                raise ValueError(f"第 {line_no} 行缺少 product 值")
            try:
                amount = Decimal(amount_text)
            except (InvalidOperation, TypeError):
                raise ValueError(
                    f"第 {line_no} 行 amount 不是合法数字: {amount_text!r}"
                ) from None
            date_text = record.get("date", "") or ""
            parsed = parse_date(date_text)
            month = f"{parsed.year:04d}-{parsed.month:02d}" if parsed else None
            rows.append(
                SalesRow(
                    date=date_text,
                    product=product,
                    amount=amount,
                    month=month,
                    line_no=line_no,
                )
            )
    return rows


def aggregate_by_product(rows: Iterable[SalesRow]) -> dict[str, Decimal]:
    """按商品名称汇总金额。

    Returns:
        {商品: 金额合计}。金额用 Decimal 表示。
    """
    totals: defaultdict[str, Decimal] = defaultdict(Decimal)
    for row in rows:
        totals[row.product] += row.amount
    return dict(totals)


def format_report(
    totals: Mapping[str, Decimal],
    fmt: str = "table",
    decimals: int = 2,
) -> str:
    """把汇总结果格式化为可读文本。

    Args:
        totals: 商品 -> 金额。
        fmt: ``table``（默认）或 ``csv``。
        decimals: 金额保留的小数位数。
    """
    items = sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))
    total = sum(totals.values(), Decimal("0"))

    if fmt == "csv":
        lines = ["product,amount"]
        lines += [f"{product},{_fmt_amount(amount, decimals)}" for product, amount in items]
        lines.append(f"TOTAL,{_fmt_amount(total, decimals)}")
        return "\n".join(lines)

    if not items:
        return "(无数据)"

    name_width = max(len("product"), *(len(p) for p, _ in items))
    header = f"{'product':<{name_width}}  {'amount':>12}"
    sep = "-" * len(header)
    body = [
        f"{product:<{name_width}}  {_fmt_amount(amount, decimals):>12}"
        for product, amount in items
    ]
    footer = f"{'TOTAL':<{name_width}}  {_fmt_amount(total, decimals):>12}"
    return "\n".join([header, sep, *body, sep, footer])


def _fmt_amount(amount: Decimal, decimals: int) -> str:
    """金额格式化：定点小数，去掉多余的尾随零。"""
    quantized = amount.quantize(Decimal(1).scaleb(-decimals))
    text = f"{quantized:,.{decimals}f}"
    if decimals > 0:
        text = text.rstrip("0").rstrip(".")
        if text in ("", "-"):
            text = "0"
    return text


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="按商品汇总销售金额 (amount)")
    parser.add_argument("csv_file", help="销售数据 CSV 文件路径")
    parser.add_argument(
        "--month",
        metavar="YYYY-MM",
        default=None,
        help="只统计指定月份的数据，例如 --month 2026-01（默认统计全部）",
    )
    parser.add_argument(
        "--format",
        choices=("table", "csv"),
        default="table",
        help="输出格式（默认 table）",
    )
    parser.add_argument(
        "--decimals",
        type=int,
        default=2,
        help="金额小数位数（默认 2）",
    )
    args = parser.parse_args(argv)

    if args.month is not None:
        try:
            validate_month(args.month)
        except ValueError as exc:
            parser.error(str(exc))  # 退出码 2，与 argparse 其他用法错误一致

    try:
        rows = read_sales_csv(args.csv_file, require_date=args.month is not None)
        if args.month is not None:
            rows = filter_by_month(rows, args.month)
    except (OSError, ValueError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    totals = aggregate_by_product(rows)
    print(format_report(totals, fmt=args.format, decimals=args.decimals))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
