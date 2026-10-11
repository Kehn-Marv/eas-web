/**
 * Test script for flow diagram generation
 * 
 * Usage: 
 * 1. Set your API key: export TOGETHER_API_KEY=your_key_here
 * 2. Run: npx tsx lib/test-flow-generation.ts
 */

import { createLessons } from "../lib/create-lesson";
import type { Module } from "../lib/types";

const API_KEY = process.env.TOGETHER_API_KEY || "";

if (!API_KEY) {
  console.error("❌ Please set TOGETHER_API_KEY environment variable");
  process.exit(1);
}

const testModule: Module = {
  title: "Photosynthesis Process",
};

const testContent = `
Photosynthesis is the process by which plants convert light energy into chemical energy. The process occurs in two main stages: the light-dependent reactions and the Calvin cycle.

The light-dependent reactions begin when photons are captured by chlorophyll molecules in Photosystem II (PS II). This excites electrons, which then pass through an electron transport chain containing cytochrome b6f. The excited electrons eventually reach Photosystem I (PS I), where they gain more energy from additional light.

As electrons move through PS II, water molecules are split in a process called photolysis, releasing oxygen gas as a byproduct. The electron transport creates a proton gradient across the thylakoid membrane. This gradient drives ATP synthesis through ATP synthase, often called chemiosmosis.

Meanwhile, PS I uses the energized electrons to reduce NADP+ to NADPH. Both ATP and NADPH are then used in the Calvin cycle to fix carbon dioxide into glucose.

The entire process is a coordinated flow: light capture → electron excitation → water splitting → electron transport → proton gradient → ATP/NADPH production → carbon fixation.
`;

async function test() {
  console.log("🧪 Testing flow diagram generation with photosynthesis content...\n");
  
  try {
    const result = await createLessons({
      module: testModule,
      content: testContent,
      apiKey: API_KEY,
      validateStructure: true,
      validateContent: true,
      retryFailures: true,
      onProgress: (type, message, data) => {
        console.log(`📊 Progress: ${type} - ${message}`);
      },
    });

    console.log("\n" + "=".repeat(60));
    console.log("✅ TEST RESULTS");
    console.log("=".repeat(60));
    console.log(`Module: ${result.title}`);
    console.log(`Total lessons: ${result.lessons.length}`);
    
    result.lessons.forEach((lessonResult, index) => {
      if (lessonResult.success) {
        const lesson = lessonResult.data;
        console.log(`\n${index + 1}. ${lesson.title}`);
        console.log(`   Type: ${lesson.questionType}`);
        
        if (lesson.questionType === "flow-diagram") {
          console.log(`   ✨ FLOW DIAGRAM DETECTED!`);
          console.log(`   Nodes: ${lesson.flowConfig.nodes.length}`);
          console.log(`   Edges: ${lesson.flowConfig.edges.length}`);
          console.log(`   Choices: ${lesson.choices.length}`);
          console.log(`   Question: ${lesson.question}`);
          console.log(`\n   Flow structure:`);
          lesson.flowConfig.nodes.forEach((node) => {
            console.log(`     - [${node.type}] ${node.label}`);
          });
          console.log(`\n   Connections:`);
          lesson.flowConfig.edges.forEach((edge) => {
            console.log(`     ${edge[0]} → ${edge[1]}`);
          });
        }
      } else {
        console.log(`\n${index + 1}. ❌ FAILED`);
        console.log(`   Reason: ${lessonResult.error.reason}`);
      }
    });

    const flowLesson = result.lessons.find(
      (l) => l.success && l.data.questionType === "flow-diagram"
    );
    
    if (flowLesson) {
      console.log("\n" + "=".repeat(60));
      console.log("✅ SUCCESS: Flow diagram lesson was generated!");
      console.log("=".repeat(60));
    } else {
      console.log("\n" + "=".repeat(60));
      console.log("⚠️  No flow diagram lesson was generated");
      console.log("This could mean the content wasn't detected as suitable for a flow.");
      console.log("=".repeat(60));
    }

  } catch (error) {
    console.error("\n❌ Test failed with error:");
    console.error(error);
    process.exit(1);
  }
}

test();

