import unittest

from reading_list import ReadingList


class ReadingListRepairTest(unittest.TestCase):
    def test_remove_ignores_case_and_surrounding_whitespace(self):
        reading_list = ReadingList()
        reading_list.add("Dune")
        reading_list.add("Foundation")

        self.assertTrue(reading_list.remove("  dUnE  "))
        self.assertEqual(reading_list.titles(), ["Foundation"])

    def test_remove_missing_title_returns_false_without_changing_items(self):
        reading_list = ReadingList()
        reading_list.add("Dune")

        self.assertFalse(reading_list.remove("Hyperion"))
        self.assertEqual(reading_list.titles(), ["Dune"])


if __name__ == "__main__":
    unittest.main()
