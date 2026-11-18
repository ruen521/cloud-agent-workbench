#!/usr/bin/env python3
"""aggregate_sales 的单元测试。

运行：
    python3 -m unittest discover -s outputs -v
    python3 outputs/test_aggregate_sales.py -v
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aggregate_sales import (  # noqa: E402
    SalesRow,
    aggregate_by_product,
    filter_by_month,
    format_report,
    main,
    parse_date,
    read_sales_csv,
    row_month,
    validate_month,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
SAMPLE_CSV = REPO_ROOT / "inputs" / "sales.csv"


def write_csv(text: str) -> str:
    """把 CSV 文本写入临时文件，返回路径。"""
    fd, path = tempfile.mkstemp(suffix=".csv", text=True)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    return path


class TestReadSalesCsv(unittest.TestCase):
    def test_reads_sample_file(self):
        """读取实际输入文件，应得到 4 条记录。"""
        rows = read_sales_csv(SAMPLE_CSV)
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0].product, "Notebook")
        self.assertEqual(rows[0].amount, Decimal("120"))
        self.assertEqual(rows[0].date, "2026-01-05")
        self.assertEqual(rows[-1].product, "Pen")
        self.assertEqual(rows[-1].amount, Decimal("25"))

    def test_skips_blank_lines(self):
        path = write_csv("date,product,amount\n2026-01-05,Notebook,120\n\n,\n")
        try:
            rows = read_sales_csv(path)
        finally:
            os.unlink(path)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].product, "Notebook")

    def test_parses_decimal_amounts(self):
        path = write_csv("date,product,amount\n2026-01-05,Notebook,12.50\n")
        try:
            rows = read_sales_csv(path)
        finally:
            os.unlink(path)
        self.assertEqual(rows[0].amount, Decimal("12.50"))

    def test_handles_negative_amount(self):
        path = write_csv("date,product,amount\n2026-01-05,Refund,-20\n")
        try:
            rows = read_sales_csv(path)
        finally:
            os.unlink(path)
        self.assertEqual(rows[0].amount, Decimal("-20"))

    def test_missing_column_raises(self):
        path = write_csv("date,product\n2026-01-05,Notebook\n")
        try:
            with self.assertRaises(ValueError) as ctx:
                read_sales_csv(path)
        finally:
            os.unlink(path)
        self.assertIn("amount", str(ctx.exception))

    def test_invalid_amount_raises(self):
        path = write_csv("date,product,amount\n2026-01-05,Notebook,abc\n")
        try:
            with self.assertRaises(ValueError) as ctx:
                read_sales_csv(path)
        finally:
            os.unlink(path)
        self.assertIn("第 2 行", str(ctx.exception))

    def test_empty_product_raises(self):
        path = write_csv("date,product,amount\n2026-01-05,,120\n")
        try:
            with self.assertRaises(ValueError):
                read_sales_csv(path)
        finally:
            os.unlink(path)


class TestAggregateByProduct(unittest.TestCase):
    def test_sums_same_product(self):
        rows = [
            SalesRow("2026-01-05", "Notebook", Decimal("120")),
            SalesRow("2026-02-02", "Notebook", Decimal("80")),
        ]
        self.assertEqual(
            aggregate_by_product(rows), {"Notebook": Decimal("200")}
        )

    def test_multiple_products(self):
        rows = [
            SalesRow("2026-01-05", "Notebook", Decimal("120")),
            SalesRow("2026-01-18", "Pen", Decimal("35")),
            SalesRow("2026-02-02", "Notebook", Decimal("80")),
            SalesRow("2026-02-09", "Pen", Decimal("25")),
        ]
        totals = aggregate_by_product(rows)
        self.assertEqual(totals["Notebook"], Decimal("200"))
        self.assertEqual(totals["Pen"], Decimal("60"))

    def test_empty_input(self):
        self.assertEqual(aggregate_by_product([]), {})

    def test_decimal_precision_is_exact(self):
        """0.1 + 0.2 必须精确等于 0.3（浮点会得到 0.30000000000000004）。"""
        rows = [
            SalesRow("d", "A", Decimal("0.1")),
            SalesRow("d", "A", Decimal("0.2")),
        ]
        self.assertEqual(aggregate_by_product(rows)["A"], Decimal("0.3"))

    def test_negative_values_reduce_total(self):
        rows = [
            SalesRow("d", "A", Decimal("100")),
            SalesRow("d", "A", Decimal("-30")),
        ]
        self.assertEqual(aggregate_by_product(rows)["A"], Decimal("70"))


class TestFormatReport(unittest.TestCase):
    def setUp(self):
        self.totals = {"Notebook": Decimal("200"), "Pen": Decimal("60")}

    def test_table_contains_products_and_total(self):
        report = format_report(self.totals)
        self.assertIn("Notebook", report)
        self.assertIn("Pen", report)
        self.assertIn("TOTAL", report)
        self.assertIn("200", report)
        self.assertIn("60", report)

    def test_table_sorted_by_amount_desc(self):
        report = format_report(self.totals)
        self.assertLess(report.index("Notebook"), report.index("Pen"))

    def test_csv_format(self):
        report = format_report(self.totals, fmt="csv")
        lines = report.splitlines()
        self.assertEqual(lines[0], "product,amount")
        self.assertEqual(lines[1], "Notebook,200")
        self.assertEqual(lines[2], "Pen,60")
        self.assertEqual(lines[3], "TOTAL,260")

    def test_empty_totals(self):
        self.assertEqual(format_report({}), "(无数据)")


class TestMonthFilter(unittest.TestCase):
    """--month YYYY-MM 筛选相关的测试。"""

    def setUp(self):
        self.rows = [
            SalesRow("2026-01-05", "Notebook", Decimal("120"), "2026-01", 2),
            SalesRow("2026-01-18", "Pen", Decimal("35"), "2026-01", 3),
            SalesRow("2026-02-02", "Notebook", Decimal("80"), "2026-02", 4),
            SalesRow("2026-02-09", "Pen", Decimal("25"), "2026-02", 5),
        ]

    def test_filter_january(self):
        selected = filter_by_month(self.rows, "2026-01")
        self.assertEqual(len(selected), 2)
        self.assertTrue(all(r.month == "2026-01" for r in selected))

    def test_filter_february(self):
        selected = filter_by_month(self.rows, "2026-02")
        self.assertEqual(len(selected), 2)

    def test_filter_month_without_matches(self):
        self.assertEqual(filter_by_month(self.rows, "2025-12"), [])

    def test_filter_then_aggregate(self):
        totals = aggregate_by_product(filter_by_month(self.rows, "2026-01"))
        self.assertEqual(totals, {"Notebook": Decimal("120"), "Pen": Decimal("35")})

    def test_invalid_month_raises(self):
        for bad in ("2026-1", "2026-13", "202601", "abc", "2026-00", ""):
            with self.subTest(month=bad):
                with self.assertRaises(ValueError):
                    validate_month(bad)

    def test_valid_months(self):
        self.assertEqual(validate_month("2026-01"), "2026-01")
        self.assertEqual(validate_month("2026-12"), "2026-12")

    def test_row_with_unparsable_date_raises(self):
        rows = [SalesRow("not-a-date", "Notebook", Decimal("10"), None, 7)]
        with self.assertRaises(ValueError) as ctx:
            filter_by_month(rows, "2026-01")
        self.assertIn("第 7 行", str(ctx.exception))

    def test_parse_date_formats(self):
        self.assertIsNotNone(parse_date("2026-01-05"))
        self.assertIsNotNone(parse_date("2026/01/05"))
        self.assertIsNotNone(parse_date("20260105"))
        self.assertIsNotNone(parse_date("2026-01-05T10:00:00"))
        self.assertIsNone(parse_date(""))
        self.assertIsNone(parse_date("garbage"))

    def test_row_month_derived_from_date(self):
        row = SalesRow("2026-01-05", "Notebook", Decimal("1"))
        self.assertEqual(row_month(row), "2026-01")

    def test_read_csv_computes_month(self):
        path = write_csv("date,product,amount\n2026-01-05,Notebook,120\n")
        try:
            rows = read_sales_csv(path)
        finally:
            os.unlink(path)
        self.assertEqual(rows[0].month, "2026-01")

    def test_read_csv_require_date_column(self):
        path = write_csv("product,amount\nNotebook,120\n")
        try:
            with self.assertRaises(ValueError) as ctx:
                read_sales_csv(path, require_date=True)
        finally:
            os.unlink(path)
        self.assertIn("date", str(ctx.exception))


class TestEndToEnd(unittest.TestCase):
    def test_cli_on_sample_file(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "aggregate_sales.py"),
             str(SAMPLE_CSV)],
            capture_output=True, text=True, check=True,
        )
        self.assertIn("Notebook", result.stdout)
        self.assertIn("200", result.stdout)
        self.assertIn("60", result.stdout)

    def test_cli_csv_format(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "aggregate_sales.py"),
             str(SAMPLE_CSV), "--format", "csv"],
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(
            result.stdout.strip().splitlines(),
            ["product,amount", "Notebook,200", "Pen,60", "TOTAL,260"],
        )

    def test_cli_reports_error_for_missing_file(self):
        stderr = io.StringIO()
        old = sys.stderr
        sys.stderr = stderr
        try:
            code = main(["does_not_exist.csv"])
        finally:
            sys.stderr = old
        self.assertEqual(code, 1)
        self.assertIn("错误", stderr.getvalue())

    def test_cli_with_month_january(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "aggregate_sales.py"),
             str(SAMPLE_CSV), "--month", "2026-01", "--format", "csv"],
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(
            result.stdout.strip().splitlines(),
            ["product,amount", "Notebook,120", "Pen,35", "TOTAL,155"],
        )

    def test_cli_with_month_february(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "aggregate_sales.py"),
             str(SAMPLE_CSV), "--month", "2026-02", "--format", "csv"],
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(
            result.stdout.strip().splitlines(),
            ["product,amount", "Notebook,80", "Pen,25", "TOTAL,105"],
        )

    def test_cli_without_month_keeps_all_rows(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "aggregate_sales.py"),
             str(SAMPLE_CSV), "--format", "csv"],
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(
            result.stdout.strip().splitlines(),
            ["product,amount", "Notebook,200", "Pen,60", "TOTAL,260"],
        )

    def test_cli_with_month_no_matching_rows(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "aggregate_sales.py"),
             str(SAMPLE_CSV), "--month", "2025-12"],
            capture_output=True, text=True, check=True,
        )
        self.assertIn("(无数据)", result.stdout)

    def test_cli_rejects_invalid_month(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parent / "aggregate_sales.py"),
             str(SAMPLE_CSV), "--month", "2026-13"],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("YYYY-MM", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
