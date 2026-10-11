#!/bin/bash

# Example curl command to test the /api/grade-short-answer endpoint
# 
# Usage:
#   ./scripts/test-curl-example.sh
#   Or copy the curl command below and modify as needed

# Uses TOGETHER_API_KEY environment variable
# Set BASE_URL if testing against a different server
API_KEY="${TOGETHER_API_KEY}"
BASE_URL="${BASE_URL:-http://localhost:3000}"

if [ -z "$API_KEY" ]; then
  echo "❌ Error: TOGETHER_API_KEY environment variable is not set"
  echo "   Set it with: export TOGETHER_API_KEY=your-key-here"
  exit 1
fi

echo "Testing /api/grade-short-answer endpoint"
echo "URL: $BASE_URL"
echo "API Key: ${API_KEY:0:10}..."
echo ""

# Example 1: Correct answer (exact match)
echo "Test 1: Correct answer (exact match)"
curl -X POST "$BASE_URL/api/grade-short-answer" \
  -H "Content-Type: application/json" \
  -H "X-Together-API-Key: $API_KEY" \
  -d '{
    "userAnswer": "recurrent and convolutional neural networks",
    "correctAnswer": "recurrent and convolutional neural networks",
    "content": "The Transformer architecture is a novel neural network design that dispenses with recurrence and convolution, relying solely on attention mechanisms.",
    "info": "The Transformer was the first transduction model to rely entirely on self-attention.",
    "question": "What are the two types of neural network components that the Transformer architecture completely avoids using?"
  }' | jq '.'

echo -e "\n\n"

# Example 2: Correct answer (paraphrased)
echo "Test 2: Correct answer (paraphrased)"
curl -X POST "$BASE_URL/api/grade-short-answer" \
  -H "Content-Type: application/json" \
  -H "X-Together-API-Key: $API_KEY" \
  -d '{
    "userAnswer": "The Transformer avoids using recurrent networks and convolutional networks",
    "correctAnswer": "recurrent and convolutional neural networks",
    "content": "The Transformer architecture is a novel neural network design that dispenses with recurrence and convolution, relying solely on attention mechanisms.",
    "info": "The Transformer was the first transduction model to rely entirely on self-attention.",
    "question": "What are the two types of neural network components that the Transformer architecture completely avoids using?"
  }' | jq '.'

echo -e "\n\n"

# Example 3: Incorrect answer
echo "Test 3: Incorrect answer"
curl -X POST "$BASE_URL/api/grade-short-answer" \
  -H "Content-Type: application/json" \
  -H "X-Together-API-Key: $API_KEY" \
  -d '{
    "userAnswer": "feedforward and backpropagation networks",
    "correctAnswer": "recurrent and convolutional neural networks",
    "content": "The Transformer architecture is a novel neural network design that dispenses with recurrence and convolution, relying solely on attention mechanisms.",
    "info": "The Transformer was the first transduction model to rely entirely on self-attention.",
    "question": "What are the two types of neural network components that the Transformer architecture completely avoids using?"
  }' | jq '.'

echo -e "\n\n"

# Example 4: Test credits system (run this 13+ times to exhaust credits)
echo "Test 4: Credits test (users start with 12 credits, each request costs 1)"
echo "Run this 13+ times to exhaust credits and see the error"
curl -X POST "$BASE_URL/api/grade-short-answer" \
  -H "Content-Type: application/json" \
  -H "X-Together-API-Key: $API_KEY" \
  -d '{
    "userAnswer": "test",
    "correctAnswer": "test",
    "content": "test",
    "info": "test",
    "question": "test"
  }' \
  -w "\nHTTP Status: %{http_code}\n" \
  -i \
  -s | jq '.' || echo "Response received"

echo -e "\n\nDone!"

