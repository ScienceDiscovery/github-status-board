import unittest

from collection_context import collection_context


class CollectionContextTests(unittest.TestCase):
    def test_each_dashboard_chooses_its_own_source(self):
        prod = collection_context("ScienceDiscovery/github-status-board")
        test = collection_context("sciencediscovery/github-status-board-test", "SCiencediscovery/sciencediscovery", "refresh-17")
        self.assertEqual(prod["source"], "openJiuwen-ai/sciencediscovery")
        self.assertEqual(test["source"], "ScienceDiscovery/sciencediscovery")
        self.assertEqual(prod["source_owner"], "openJiuwen-ai")
        self.assertEqual(test["target_name"], "github-status-board-test")

    def test_cross_site_and_unknown_repository_are_rejected(self):
        for destination, source in [("ScienceDiscovery/github-status-board", "ScienceDiscovery/sciencediscovery"),
                                    ("evil/dashboard", ""), ("ScienceDiscovery/github-status-board-test", "openJiuwen-ai/sciencediscovery")]:
            with self.subTest(destination=destination, source=source), self.assertRaises(ValueError):
                collection_context(destination, source)

    def test_request_id_cannot_inject_workflow_outputs(self):
        for request_id in ["refresh-1\nsource=other/repo", "$(curl example.org)", "x" * 101]:
            with self.subTest(request_id=request_id), self.assertRaises(ValueError):
                collection_context("ScienceDiscovery/github-status-board", request_id=request_id)
