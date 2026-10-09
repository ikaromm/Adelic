import unittest

from reading_list import ReadingList


class ReadingListFollowupTest(unittest.TestCase):
    def test_repair_and_read_tracking_preserve_original_titles_and_order(self):
        reading_list = ReadingList()
        reading_list.add("Dune")
        reading_list.add("Foundation")
        reading_list.add("Hyperion")

        self.assertTrue(reading_list.remove("  dUnE "))
        self.assertTrue(reading_list.mark_read(" FOUNDATION "))
        self.assertTrue(reading_list.mark_read("foundation"))
        self.assertTrue(reading_list.mark_read("Hyperion"))
        self.assertFalse(reading_list.mark_read("Dune"))
        self.assertEqual(reading_list.read_titles(), ["Foundation", "Hyperion"])

        self.assertTrue(reading_list.remove("HYPERION"))
        self.assertEqual(reading_list.read_titles(), ["Foundation"])
        self.assertEqual(reading_list.titles(), ["Foundation"])


if __name__ == "__main__":
    unittest.main()
