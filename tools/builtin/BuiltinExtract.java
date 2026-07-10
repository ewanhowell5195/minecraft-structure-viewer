// Extracts the game's hardcoded (code-built) structures into standard
// structure .nbt files by running the real piece/feature code against a
// capturing WorldGenLevel. Compiled with javac against the unobfuscated
// server jar and run by extract.js.
//
// Pieces are instantiated with orientation NORTH: coords map to
// world = (minX + x, minY + y, maxZ - z) with NO state mirror/rotation,
// so un-flipping z at write time recovers the exact authored local blocks.
// The viewer's layout generators re-apply the game's orientation transform.
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.DoubleTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.server.Bootstrap;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.LevelHeightAccessor;
import net.minecraft.world.level.WorldGenLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.level.chunk.PalettedContainerFactory;
import net.minecraft.world.level.chunk.UpgradeData;
import net.minecraft.world.level.levelgen.feature.BonusChestFeature;
import net.minecraft.world.level.levelgen.feature.DesertWellFeature;
import net.minecraft.world.level.levelgen.feature.EndGatewayFeature;
import net.minecraft.world.level.levelgen.feature.EndPlatformFeature;
import net.minecraft.world.level.levelgen.feature.EndPodiumFeature;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.ScatteredFeaturePiece;
import net.minecraft.world.level.levelgen.structure.StructurePiece;
import net.minecraft.world.level.levelgen.structure.StructurePieceAccessor;
import net.minecraft.world.level.levelgen.structure.structures.BuriedTreasurePieces;
import net.minecraft.world.level.levelgen.structure.structures.NetherFortressPieces;
import net.minecraft.world.level.levelgen.structure.structures.DesertPyramidPiece;
import net.minecraft.world.level.levelgen.structure.structures.JungleTemplePiece;
import net.minecraft.world.level.levelgen.structure.structures.SwampHutPiece;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.material.Fluid;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.ticks.TickContainerAccess;

public class BuiltinExtract {
  static HolderLookup.Provider REGS;
  static Path OUT;

  // ---------------------------------------------------------------- random

  // A random that returns fixed values, so extraction is canonical and
  // repeatable. floatVal is tunable per run: diffing two runs with different
  // floatVal exposes exactly the cells a BlockSelector randomises.
  static class CannedRandom implements RandomSource {
    float floatVal;
    boolean boolVal;
    int intVal; // nextInt(bound) result once the script runs out
    final ArrayDeque<Integer> script = new ArrayDeque<>(); // consumed first by nextInt(bound)
    CannedRandom(float f) { this(f, false); }
    CannedRandom(float f, boolean b) { floatVal = f; boolVal = b; }
    CannedRandom script(int... vs) { for (int v : vs) script.add(v); return this; }
    public RandomSource fork() { return new CannedRandom(floatVal, boolVal); }
    public net.minecraft.world.level.levelgen.PositionalRandomFactory forkPositional() { throw new UnsupportedOperationException("forkPositional"); }
    public void setSeed(long seed) {}
    public int nextInt() { return 0; }
    public int nextInt(int bound) { return Math.min(script.isEmpty() ? intVal : script.poll(), bound - 1); }
    public long nextLong() { return 0; }
    public boolean nextBoolean() { return boolVal; }
    public float nextFloat() { return floatVal; }
    public double nextDouble() { return floatVal; }
    public double nextGaussian() { return 0; }
  }

  // canonical run and a divergent run: cells that differ between the two are
  // exactly the ones a random selector controls, and become fixer masks
  static CannedRandom runA() { return new CannedRandom(0.9f, false); }
  static CannedRandom runB() { return new CannedRandom(0.1f, true); }

  // ---------------------------------------------------------------- capture

  static class DummyChunk extends ChunkAccess {
    DummyChunk() {
      super(new ChunkPos(0, 0), UpgradeData.EMPTY, LevelHeightAccessor.create(0, 0),
        new PalettedContainerFactory(null, null, null, null, null, null), 0L, null, null);
    }
    @Override public void markPosForPostProcessing(BlockPos pos) {}
    public BlockState setBlockState(BlockPos pos, BlockState state, int flags) { return null; }
    public void setBlockEntity(BlockEntity blockEntity) {}
    public void addEntity(Entity entity) {}
    public ChunkStatus getPersistedStatus() { return ChunkStatus.EMPTY; }
    public void removeBlockEntity(BlockPos pos) {}
    public CompoundTag getBlockEntityNbtForSaving(BlockPos pos, HolderLookup.Provider regs) { return null; }
    public TickContainerAccess<Block> getBlockTicks() { return null; }
    public TickContainerAccess<Fluid> getFluidTicks() { return null; }
    public ChunkAccess.PackedTicks getTicksForSerialization(long tick) { return null; }
    public BlockState getBlockState(BlockPos pos) { return Blocks.AIR.defaultBlockState(); }
    public net.minecraft.world.level.material.FluidState getFluidState(BlockPos pos) { return Blocks.AIR.defaultBlockState().getFluidState(); }
    public BlockEntity getBlockEntity(BlockPos pos) { return null; }
  }

  static class Capture {
    final Map<BlockPos, BlockState> placed = new LinkedHashMap<>();
    final Map<BlockPos, BlockEntity> bes = new HashMap<>();
    final List<CompoundTag> entities = new ArrayList<>();
    final Map<BlockPos, BlockState> world = new HashMap<>(); // pre-existing terrain, not captured
    int groundY = Integer.MIN_VALUE;                          // below this the world reads as `ground`
    BlockState ground = Blocks.STONE.defaultBlockState();
    int heightmapY = 0;                                       // heightmap answers
    int minY = -64;                                           // world floor (the End uses 0)
    CannedRandom random = runA();                             // level.getRandom()
    final Set<String> unknown = new TreeSet<>();
    final ChunkAccess chunk = new DummyChunk();

    void fillWorld(int x0, int y0, int z0, int x1, int y1, int z1, BlockState s) {
      for (int y = y0; y <= y1; y++)
        for (int x = x0; x <= x1; x++)
          for (int z = z0; z <= z1; z++) world.put(new BlockPos(x, y, z), s);
    }

    // adopt untouched prefilled terrain into the output (dressing around a
    // piece that in game is embedded in the ground)
    void includeWorld(int x0, int y0, int z0, int x1, int y1, int z1) {
      for (int y = y0; y <= y1; y++)
        for (int x = x0; x <= x1; x++)
          for (int z = z0; z <= z1; z++) {
            BlockPos p = new BlockPos(x, y, z);
            BlockState s = world.get(p);
            if (s != null && !placed.containsKey(p)) placed.put(p, s);
          }
    }

    BlockState get(BlockPos p) {
      BlockState s = placed.get(p);
      if (s == null) s = world.get(p);
      if (s == null) s = p.getY() < groundY ? ground : Blocks.AIR.defaultBlockState();
      return s;
    }

    void set(BlockPos p0, BlockState s) {
      BlockPos p = p0.immutable();
      placed.put(p, s);
      bes.remove(p);
      if (s.hasBlockEntity() && s.getBlock() instanceof EntityBlock eb) {
        BlockEntity be = eb.newBlockEntity(p, s);
        if (be != null) bes.put(p, be);
      }
    }

    WorldGenLevel level() {
      InvocationHandler h = (proxy, method, a) -> {
        String n = method.getName();
        switch (n) {
          case "setBlock": case "setBlockAndUpdate": { set((BlockPos) a[0], (BlockState) a[1]); return true; }
          case "destroyBlock": case "removeBlock": { set((BlockPos) a[0], Blocks.AIR.defaultBlockState()); return true; }
          case "getBlockState": return get((BlockPos) a[0]);
          case "getFluidState": return get((BlockPos) a[0]).getFluidState();
          case "getBlockEntity": {
            BlockEntity be = bes.get(((BlockPos) a[0]).immutable());
            if (a.length < 2) return be;
            return be != null && be.getType() == a[1] ? Optional.of(be) : Optional.empty();
          }
          case "isEmptyBlock": return get((BlockPos) a[0]).isAir();
          case "getMinY": return minY;
          case "getMaxY": return 319;
          case "getSeaLevel": return 63;
          case "getChunk": return chunk;
          case "getHeight": return a == null || a.length == 0 ? 384 : heightmapY;
          case "getHeightmapPos": {
            BlockPos p = (BlockPos) a[1];
            return new BlockPos(p.getX(), heightmapY, p.getZ());
          }
          case "isInsideBuildHeight": return true;
          case "getRandom": return random;
          case "addFreshEntity": return true;
          case "toString": return "CaptureLevel";
          case "hashCode": return System.identityHashCode(proxy);
          case "equals": return proxy == a[0];
          default: {
            unknown.add(n);
            Class<?> r = method.getReturnType();
            if (r == boolean.class) return false;
            if (r == int.class) return 0;
            if (r == long.class) return 0L;
            if (r == float.class) return 0f;
            if (r == double.class) return 0d;
            return null;
          }
        }
      };
      return (WorldGenLevel) Proxy.newProxyInstance(WorldGenLevel.class.getClassLoader(), new Class<?>[]{ WorldGenLevel.class }, h);
    }
  }

  // ------------------------------------------------------------------- nbt

  @SuppressWarnings({"unchecked", "rawtypes"})
  static String pval(BlockState s, Property p) { return p.getName(s.getValue(p)); }

  static CompoundTag paletteEntry(BlockState s) {
    CompoundTag e = new CompoundTag();
    e.putString("Name", BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString());
    if (!s.getProperties().isEmpty()) {
      CompoundTag props = new CompoundTag();
      for (Property<?> p : s.getProperties()) props.putString(p.getName(), pval(s, p));
      e.put("Properties", props);
    }
    return e;
  }

  static void write(String name, Capture cap, BoundingBox bb, boolean northFlip) throws Exception {
    write(name, cap, bb, northFlip, null);
  }

  // bb null: fit to the non-air extents of what was placed. northFlip: the
  // capture ran as an orientation-NORTH piece, so unflip z to authored space.
  // masks: named world-position lists of randomised cells, written to a
  // .rand.json sidecar in the same local space for the viewer's fixers.
  static void write(String name, Capture cap, BoundingBox bb, boolean northFlip, Map<String, List<BlockPos>> masks) throws Exception {
    if (bb == null) {
      int[] lo = { Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE }, hi = { Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE };
      for (Map.Entry<BlockPos, BlockState> e : cap.placed.entrySet()) {
        if (e.getValue().isAir()) continue;
        BlockPos p = e.getKey();
        lo[0] = Math.min(lo[0], p.getX()); lo[1] = Math.min(lo[1], p.getY()); lo[2] = Math.min(lo[2], p.getZ());
        hi[0] = Math.max(hi[0], p.getX()); hi[1] = Math.max(hi[1], p.getY()); hi[2] = Math.max(hi[2], p.getZ());
      }
      if (lo[0] > hi[0]) throw new IllegalStateException(name + ": nothing captured");
      bb = new BoundingBox(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    }

    ListTag palette = new ListTag();
    Map<BlockState, Integer> palIdx = new LinkedHashMap<>();
    ListTag blocks = new ListTag();
    int skipped = 0;
    for (Map.Entry<BlockPos, BlockState> e : cap.placed.entrySet()) {
      BlockPos p = e.getKey();
      if (!bb.isInside(p)) { skipped++; continue; }
      BlockState s = e.getValue();
      Integer idx = palIdx.get(s);
      if (idx == null) { idx = palette.size(); palIdx.put(s, idx); palette.add(paletteEntry(s)); }
      int lx = p.getX() - bb.minX(), ly = p.getY() - bb.minY();
      int lz = northFlip ? bb.maxZ() - p.getZ() : p.getZ() - bb.minZ();
      CompoundTag b = new CompoundTag();
      b.putInt("state", idx);
      b.put("pos", intList(lx, ly, lz));
      BlockEntity be = cap.bes.get(p);
      if (be != null) {
        CompoundTag t = be.saveWithoutMetadata(REGS);
        t.putString("id", BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(be.getType()).toString());
        b.put("nbt", t);
      }
      blocks.add(b);
    }

    ListTag entities = new ListTag();
    for (CompoundTag nbt : cap.entities) {
      // entity positions arrive world-space, shift/flip like blocks
      ListTag pos = nbt.getListOrEmpty("pos");
      double ex = pos.getDoubleOr(0, 0) - bb.minX(), ey = pos.getDoubleOr(1, 0) - bb.minY();
      double ez = northFlip ? bb.maxZ() + 1 - (pos.getDoubleOr(2, 0)) : pos.getDoubleOr(2, 0) - bb.minZ();
      CompoundTag e = new CompoundTag();
      ListTag dp = new ListTag();
      dp.add(DoubleTag.valueOf(ex)); dp.add(DoubleTag.valueOf(ey)); dp.add(DoubleTag.valueOf(ez));
      e.put("pos", dp);
      e.put("blockPos", intList((int) Math.floor(ex), (int) Math.floor(ey), (int) Math.floor(ez)));
      e.put("nbt", nbt.getCompoundOrEmpty("nbt"));
      entities.add(e);
    }

    CompoundTag root = new CompoundTag();
    root.put("size", intList(bb.getXSpan(), bb.getYSpan(), bb.getZSpan()));
    root.put("palette", palette);
    root.put("blocks", blocks);
    root.put("entities", entities);
    root.putInt("DataVersion", SharedConstants.getCurrentVersion().dataVersion().version());

    Path file = OUT.resolve("data/minecraft/structure/builtin/" + name + ".nbt");
    Files.createDirectories(file.getParent());
    NbtIo.writeCompressed(root, file);

    int maskCells = 0;
    if (masks != null && !masks.isEmpty()) {
      StringBuilder json = new StringBuilder("{\n");
      boolean firstMask = true;
      for (Map.Entry<String, List<BlockPos>> m : masks.entrySet()) {
        if (!firstMask) json.append(",\n");
        firstMask = false;
        json.append("  \"").append(m.getKey()).append("\": [");
        boolean firstCell = true;
        List<int[]> local = new ArrayList<>();
        for (BlockPos p : m.getValue()) {
          if (!bb.isInside(p)) { System.out.println("[builtin] WARN mask cell outside bb: " + name + " " + m.getKey() + " " + p); continue; }
          int lz = northFlip ? bb.maxZ() - p.getZ() : p.getZ() - bb.minZ();
          local.add(new int[]{ p.getX() - bb.minX(), p.getY() - bb.minY(), lz });
        }
        local.sort(Comparator.<int[]>comparingInt(c -> c[1]).thenComparingInt(c -> c[2]).thenComparingInt(c -> c[0]));
        for (int[] c : local) {
          if (!firstCell) json.append(",");
          firstCell = false;
          json.append("[").append(c[0]).append(",").append(c[1]).append(",").append(c[2]).append("]");
          maskCells++;
        }
        json.append("]");
      }
      json.append("\n}\n");
      Files.writeString(OUT.resolve("data/minecraft/structure/builtin/" + name + ".rand.json"), json.toString());
    }

    System.out.println("[builtin] " + name + ": " + blocks.size() + " blocks, " + bb.getXSpan() + "x" + bb.getYSpan() + "x" + bb.getZSpan()
      + (maskCells > 0 ? ", " + maskCells + " mask cells" : "")
      + (skipped > 0 ? " (" + skipped + " outside bb)" : "")
      + (cap.unknown.isEmpty() ? "" : " unknown level calls: " + cap.unknown));
  }

  static ListTag intList(int... vs) {
    ListTag l = new ListTag();
    for (int v : vs) l.add(IntTag.valueOf(v));
    return l;
  }

  static HolderLookup.Provider worldLookup() {
    for (String name : new String[]{ "createWorldLookup", "createLookup" }) {
      try { return (HolderLookup.Provider) VanillaRegistries.class.getMethod(name).invoke(null); }
      catch (NoSuchMethodException e) { continue; }
      catch (Exception e) { throw new RuntimeException(e); }
    }
    throw new RuntimeException("no VanillaRegistries world-lookup factory found");
  }

  // ---------------------------------------------------------------- pieces

  static final BoundingBox WORLD_BB = new BoundingBox(-100000, -1000, -100000, 100000, 1000, 100000);

  // world position under the NORTH orientation transform
  static BlockPos northWorldPos(BoundingBox bb, int x, int y, int z) {
    return new BlockPos(bb.minX() + x, bb.minY() + y, bb.maxZ() - z);
  }

  static void setHeightPosition(StructurePiece piece, int v) throws Exception {
    java.lang.reflect.Field f = ScatteredFeaturePiece.class.getDeclaredField("heightPosition");
    f.setAccessible(true);
    f.setInt(piece, v);
  }

  interface PieceRun { StructurePiece run(Capture cap, CannedRandom rand) throws Exception; }

  // runs the piece twice (canonical + divergent random) and returns the
  // canonical capture plus the diff cells, classified by the given namer
  static Capture runTwice(PieceRun body, Map<String, List<BlockPos>> masks, java.util.function.Function<BlockPos, String> classify) throws Exception {
    Capture capA = new Capture();
    capA.random = runA();
    body.run(capA, capA.random);
    Capture capB = new Capture();
    capB.random = runB();
    body.run(capB, capB.random);
    if (!capA.placed.keySet().equals(capB.placed.keySet()))
      System.out.println("[builtin] WARN diff runs placed different cells (structural divergence)");
    for (Map.Entry<BlockPos, BlockState> e : capA.placed.entrySet()) {
      BlockState other = capB.placed.get(e.getKey());
      if (other == null || other == e.getValue()) continue;
      String name = classify.apply(e.getKey());
      if (name == null) { System.out.println("[builtin] WARN unclassified diff cell " + e.getKey() + ": " + e.getValue() + " vs " + other); continue; }
      masks.computeIfAbsent(name, k -> new ArrayList<>()).add(e.getKey());
    }
    return capA;
  }

  static CompoundTag entityTag(String id, double x, double y, double z) {
    CompoundTag e = new CompoundTag();
    ListTag pos = new ListTag();
    pos.add(DoubleTag.valueOf(x)); pos.add(DoubleTag.valueOf(y)); pos.add(DoubleTag.valueOf(z));
    e.put("pos", pos);
    CompoundTag nbt = new CompoundTag();
    nbt.putString("id", id);
    e.put("nbt", nbt);
    return e;
  }

  static void desertPyramid() throws Exception {
    Map<String, List<BlockPos>> masks = new LinkedHashMap<>();
    DesertPyramidPiece[] keep = new DesertPyramidPiece[1];
    Capture cap = runTwice((c, rand) -> {
      DesertPyramidPiece piece = new DesertPyramidPiece(rand, 0, 0);
      piece.setOrientation(Direction.NORTH);
      setHeightPosition(piece, 0);
      BoundingBox bb = piece.getBoundingBox();
      // desert terrain below ground level: the cellar redresses it (skipAir
      // boxes) and fillColumnDown pillars stop against it
      c.fillWorld(bb.minX() - 1, bb.minY() - 16, bb.minZ() - 1, bb.maxX() + 1, bb.minY() - 1, bb.maxZ() + 1, Blocks.SAND.defaultBlockState());
      piece.postProcess(c.level(), null, null, rand, WORLD_BB, new ChunkPos(0, 0), BlockPos.ZERO);
      // afterPlace turns every potential position into sand, then rolls 5-7
      // suspicious ones per world seed (a viewer fixer re-rolls those)
      for (BlockPos p : piece.getPotentialSuspiciousSandWorldPositions()) c.set(p, Blocks.SAND.defaultBlockState());
      keep[0] = piece;
      return piece;
    }, masks, p -> {
      int localY = p.getY() - keep[0].getBoundingBox().minY();
      return localY == 0 ? "collapsed_roof" : localY == -1 ? "stair_variant" : null;
    });
    masks.put("suspicious_sand", new ArrayList<>(keep[0].getPotentialSuspiciousSandWorldPositions()));
    write("desert_pyramid", cap, null, true, masks);
  }

  static void jungleTemple() throws Exception {
    Map<String, List<BlockPos>> masks = new LinkedHashMap<>();
    Capture cap = runTwice((c, rand) -> {
      JungleTemplePiece piece = new JungleTemplePiece(rand, 0, 0);
      piece.setOrientation(Direction.NORTH);
      setHeightPosition(piece, 0);
      piece.postProcess(c.level(), null, null, rand, WORLD_BB, new ChunkPos(0, 0), BlockPos.ZERO);
      return piece;
    }, masks, p -> "moss");
    write("jungle_temple", cap, null, true, masks);
  }

  static void swampHut() throws Exception {
    Capture cap = new Capture();
    CannedRandom rand = runA();
    cap.random = rand;
    SwampHutPiece piece = new SwampHutPiece(rand, 0, 0);
    piece.setOrientation(Direction.NORTH);
    setHeightPosition(piece, 0);
    BoundingBox bb = piece.getBoundingBox();
    cap.groundY = bb.minY(); // the stilts' fillColumnDown stops at the box
    try {
      piece.postProcess(cap.level(), null, null, rand, WORLD_BB, new ChunkPos(0, 0), BlockPos.ZERO);
    } catch (Exception e) {
      // the witch/cat spawn needs a real ServerLevel; blocks are already done
    }
    BlockPos wp = northWorldPos(bb, 2, 2, 5);
    cap.entities.add(entityTag("minecraft:witch", wp.getX() + 0.5, wp.getY(), wp.getZ() + 0.5));
    cap.entities.add(entityTag("minecraft:cat", wp.getX() + 0.5, wp.getY(), wp.getZ() + 0.5));
    write("swamp_hut", cap, null, true);
  }

  static void desertWell() throws Exception {
    Capture cap = new Capture();
    cap.random = runA();
    cap.groundY = 0;
    cap.ground = Blocks.SAND.defaultBlockState();
    BlockPos origin = new BlockPos(0, 0, 0);
    new DesertWellFeature().place(cap.level(), null, cap.random, origin);
    // the canonical random put both suspicious sands in the centre column;
    // restore them and mask the five water columns for the fixer (it re-rolls
    // one at depth 1 and one at depth 2, like the game)
    BlockPos well = origin.below(); // the feature probes down one into the sand
    cap.set(well.below(1), Blocks.SAND.defaultBlockState());
    cap.set(well.below(2), Blocks.SANDSTONE.defaultBlockState());
    List<BlockPos> cols = new ArrayList<>(List.of(well, well.east(), well.south(), well.west(), well.north()));
    write("desert_well", cap, null, false, new LinkedHashMap<>(Map.of("well_water", cols)));
  }

  static void bonusChest() throws Exception {
    Capture cap = new Capture();
    cap.random = runA();
    cap.heightmapY = 0;
    cap.fillWorld(-1, -1, -1, 16, -1, 16, Blocks.GRASS_BLOCK.defaultBlockState());
    new BonusChestFeature().place(cap.level(), null, cap.random, new BlockPos(0, 0, 0));
    // keep the grass the chest and torches stand on
    for (BlockPos p : new ArrayList<>(cap.placed.keySet())) {
      BlockPos below = p.below();
      BlockState g = cap.world.get(below);
      if (g != null && !cap.placed.containsKey(below)) cap.placed.put(below, g);
    }
    write("bonus_chest", cap, null, false);
  }

  // dungeon (MonsterRoomFeature): a Feature whose walls are pre-existing
  // terrain. each size variant is extracted inside a stone pocket with one
  // doorway hole; the viewer's generator picks the variant and re-rolls the
  // floor, spawner mob and chests per seed like the game
  static void dungeon(int xs, int zs) throws Exception {
    int xr = xs - 2, zr = zs - 2; // the nextInt(2) rolls behind each size
    Map<String, List<BlockPos>> masks = new LinkedHashMap<>();
    Capture cap = runTwice((c, rand) -> {
      rand.script(xr, zr);
      if (rand.boolVal) rand.intVal = 1; // divergent run: floor rolls mossy
      c.fillWorld(-xs - 2, -2, -zs - 2, xs + 2, 5, zs + 2, Blocks.STONE.defaultBlockState());
      // one wall opening so the hole-count gate passes (1..5 needed)
      c.world.put(new BlockPos(xs + 1, 0, 0), Blocks.AIR.defaultBlockState());
      c.world.put(new BlockPos(xs + 1, 1, 0), Blocks.AIR.defaultBlockState());
      if (!new net.minecraft.world.level.levelgen.feature.MonsterRoomFeature().place(c.level(), null, rand, BlockPos.ZERO))
        throw new IllegalStateException("dungeon refused to place");
      // the untouched stone ceiling caps the room like the cave roof in game
      c.includeWorld(-xs - 1, 4, -zs - 1, xs + 1, 4, zs + 1);
      return null;
    }, masks, p -> p.getY() == -1 ? "floor" : null);
    write("dungeon/" + (xs * 2 + 1) + "x" + (zs * 2 + 1), cap, null, false, masks);
  }

  static void buriedTreasure() throws Exception {
    Capture cap = new Capture();
    cap.random = runA();
    cap.heightmapY = 0;
    cap.fillWorld(-2, -4, -2, 2, -1, 2, Blocks.SAND.defaultBlockState());
    cap.groundY = -4;
    BuriedTreasurePieces.BuriedTreasurePiece piece = new BuriedTreasurePieces.BuriedTreasurePiece(BlockPos.ZERO);
    piece.postProcess(cap.level(), null, null, cap.random, WORLD_BB, new ChunkPos(0, 0), BlockPos.ZERO);
    cap.includeWorld(-2, -4, -2, 2, -1, 2);
    write("buried_treasure", cap, null, false);
  }

  // a single guarded spike as the tree entry for the end spikes generator;
  // the crystal (and its bedrock/fire perch) needs a real level, so it is
  // stamped manually to match placeSpike
  static void endSpike() throws Exception {
    Capture cap = new Capture();
    cap.random = runA();
    cap.minY = 0;
    var spike = new net.minecraft.world.level.levelgen.feature.EndSpikeFeature.EndSpike(0, 0, 2, 82, true);
    var feature = new net.minecraft.world.level.levelgen.feature.EndSpikeFeature(List.of(spike), false, Optional.empty());
    try {
      feature.place(cap.level(), null, cap.random, BlockPos.ZERO);
    } catch (Exception e) {
      // the EndCrystal entity creation NPEs on the proxy; blocks are done
    }
    cap.set(new BlockPos(0, 82, 0), Blocks.BEDROCK.defaultBlockState());
    cap.set(new BlockPos(0, 83, 0), Blocks.FIRE.defaultBlockState());
    cap.entities.add(entityTag("minecraft:end_crystal", 0.5, 83, 0.5));
    write("end_spike", cap, null, false);
  }

  // ---------------------------------------------------------- nether fortress

  static final StructurePieceAccessor NO_COLLISION = new StructurePieceAccessor() {
    public void addPiece(StructurePiece piece) {}
    public StructurePiece findCollisionPiece(BoundingBox box) { return null; }
  };

  // every piece extracted at orientation NORTH with its own bounding box, so
  // nbt local coords equal the game's box-local coords and the JS layout can
  // paste them at the boxes it computes
  static void fortressPiece(String name, StructurePiece piece) throws Exception {
    if (piece == null) throw new IllegalStateException(name + ": createPiece returned null");
    Capture cap = new Capture();
    cap.random = runA();
    cap.groundY = piece.getBoundingBox().minY(); // support pillars stop at the box
    piece.postProcess(cap.level(), null, null, cap.random, WORLD_BB, new ChunkPos(0, 0), BlockPos.ZERO);
    write("nether_fortress/" + name, cap, piece.getBoundingBox(), true);
  }

  static void netherFortress() throws Exception {
    CannedRandom r = runA();
    Direction N = Direction.NORTH;
    fortressPiece("bridge_straight", NetherFortressPieces.BridgeStraight.createPiece(NO_COLLISION, r, 0, 64, 0, N, 0));
    fortressPiece("bridge_crossing", NetherFortressPieces.BridgeCrossing.createPiece(NO_COLLISION, 0, 64, 0, N, 0));
    fortressPiece("room_crossing", NetherFortressPieces.RoomCrossing.createPiece(NO_COLLISION, 0, 64, 0, N, 0));
    fortressPiece("stairs_room", NetherFortressPieces.StairsRoom.createPiece(NO_COLLISION, 0, 64, 0, 0, N));
    fortressPiece("monster_throne", NetherFortressPieces.MonsterThrone.createPiece(NO_COLLISION, 0, 64, 0, 0, N));
    fortressPiece("castle_entrance", NetherFortressPieces.CastleEntrance.createPiece(NO_COLLISION, r, 0, 64, 0, N, 0));
    fortressPiece("castle_small_corridor", NetherFortressPieces.CastleSmallCorridorPiece.createPiece(NO_COLLISION, 0, 64, 0, N, 0));
    fortressPiece("castle_small_corridor_right_turn", NetherFortressPieces.CastleSmallCorridorRightTurnPiece.createPiece(NO_COLLISION, r, 0, 64, 0, N, 0));
    fortressPiece("castle_small_corridor_left_turn", NetherFortressPieces.CastleSmallCorridorLeftTurnPiece.createPiece(NO_COLLISION, r, 0, 64, 0, N, 0));
    fortressPiece("castle_corridor_stairs", NetherFortressPieces.CastleCorridorStairsPiece.createPiece(NO_COLLISION, 0, 64, 0, N, 0));
    fortressPiece("castle_corridor_t_balcony", NetherFortressPieces.CastleCorridorTBalconyPiece.createPiece(NO_COLLISION, 0, 64, 0, N, 0));
    fortressPiece("castle_small_corridor_crossing", NetherFortressPieces.CastleSmallCorridorCrossingPiece.createPiece(NO_COLLISION, 0, 64, 0, N, 0));
    fortressPiece("castle_stalk_room", NetherFortressPieces.CastleStalkRoom.createPiece(NO_COLLISION, 0, 64, 0, N, 0));
  }

  // ------------------------------------------------------------- structures

  static void endPlatform() throws Exception {
    Capture cap = new Capture();
    EndPlatformFeature.createEndPlatform(cap.level(), new BlockPos(0, 0, 0), false);
    write("end_platform", cap, null, false);
  }

  static void endGateway() throws Exception {
    Capture cap = new Capture();
    new EndGatewayFeature(Optional.empty(), false).place(cap.level(), null, new CannedRandom(0.9f), new BlockPos(0, 0, 0));
    write("end_gateway", cap, null, false);
  }

  static void exitPortal(boolean active) throws Exception {
    Capture cap = new Capture();
    BlockPos origin = new BlockPos(0, 0, 0);
    new EndPodiumFeature(active).place(cap.level(), null, new CannedRandom(0.9f), origin);
    // the first dragon fight leaves the egg on the pillar (EnderDragonFight)
    if (active) cap.set(origin.above(4), Blocks.DRAGON_EGG.defaultBlockState());
    write(active ? "exit_portal_active" : "exit_portal", cap, null, false);
  }

  public static void main(String[] args) throws Exception {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
    REGS = worldLookup();
    OUT = Path.of(args[0]);

    desertPyramid();
    jungleTemple();
    swampHut();
    desertWell();
    bonusChest();
    buriedTreasure();
    dungeon(2, 2);
    dungeon(3, 2);
    dungeon(2, 3);
    dungeon(3, 3);
    endSpike();
    netherFortress();
    endPlatform();
    endGateway();
    exitPortal(false);
    exitPortal(true);
    System.out.println("[builtin] done");
  }
}
